#!/usr/bin/env python3
"""Script de migración repetible: Identidad (UserDB) y Colaboración (BoardDB) — Paquete B.

Separa los datos que en el Prototipo 1 vivían juntos en `pizarra-db`:
  1. `auth.users` -> `UserDB` (`user-db`, base `users`), preservando exactamente los
     mismos `id` (UUID) y `password_hash` (Argon2id) sin regenerarlos.
  2. `boards`, `board_members`, `board_invites` -> `BoardDB` (`board-db`, base `boards`),
     preservando UUIDs, propietarios, membresías, roles e invitaciones.

Trabaja de forma no destructiva (solo lectura sobre el origen P1) e idempotente
sobre las bases de destino.

Uso:
    python scripts/migrate_p1_to_userdb_boarddb.py \
        --source-url postgresql+psycopg://postgres:postgres@localhost:5432/pizarra \
        --user-db-url postgresql+psycopg://postgres:postgres@localhost:5435/users \
        --board-db-url postgresql+psycopg://postgres:postgres@localhost:5433/boards
"""

import argparse
import logging
import os
import sys
from datetime import UTC, datetime

from sqlalchemy import create_engine, inspect, select, text
from sqlalchemy.orm import sessionmaker

# Permitir importar modelos de colaboracion-module al ejecutar desde la raíz o scripts/
_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.join(_ROOT, "colaboracion-module"))

from app.database import Base as BoardBase  # noqa: E402
from app.models import Board, BoardMember, BoardStatus, Invite, Role  # noqa: E402

logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] %(levelname)s - %(message)s",
)
log = logging.getLogger("migrator.identity_boards")


def _ensure_userdb_schema(user_engine) -> None:
    """Garantiza el esquema y tabla `auth.users` compatible con goose (authentication-module)."""
    is_pg = user_engine.dialect.name == "postgresql"
    with user_engine.begin() as conn:
        if is_pg:
            conn.execute(text("CREATE SCHEMA IF NOT EXISTS auth"))
            conn.execute(
                text(
                    """
                    CREATE TABLE IF NOT EXISTS auth.users (
                      id UUID PRIMARY KEY,
                      name VARCHAR(120) NOT NULL,
                      email VARCHAR(255) NOT NULL,
                      password_hash TEXT NOT NULL,
                      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                      CONSTRAINT auth_users_email_lowercase CHECK (email = LOWER(email))
                    )
                    """
                )
            )
            conn.execute(
                text(
                    "CREATE UNIQUE INDEX IF NOT EXISTS auth_users_email_unique "
                    "ON auth.users (email)"
                )
            )
        else:
            conn.execute(
                text(
                    """
                    CREATE TABLE IF NOT EXISTS auth_users (
                      id TEXT PRIMARY KEY,
                      name VARCHAR(120) NOT NULL,
                      email VARCHAR(255) NOT NULL UNIQUE,
                      password_hash TEXT NOT NULL,
                      created_at TIMESTAMP NOT NULL,
                      updated_at TIMESTAMP NOT NULL
                    )
                    """
                )
            )


def _as_dt(value: datetime | str | None, fallback: datetime | None = None) -> datetime | None:
    if value is None:
        return fallback
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=UTC)
    parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)


def _has_auth_users(engine) -> tuple[bool, str]:
    """Detecta si existe `auth.users` (PostgreSQL) o `auth_users` (SQLite de pruebas)."""
    insp = inspect(engine)
    if engine.dialect.name == "postgresql":
        schemas = insp.get_schema_names()
        if "auth" in schemas and "users" in insp.get_table_names(schema="auth"):
            return True, "auth.users"
    if "auth_users" in insp.get_table_names():
        return True, "auth_users"
    return False, ""


def migrate_users(source_engine, user_engine) -> tuple[int, bool]:
    """Copia usuarios desde P1 hacia UserDB sin alterar UUID ni hashes Argon2id."""
    _ensure_userdb_schema(user_engine)
    has_src, src_table = _has_auth_users(source_engine)
    if not has_src:
        log.info("Origen no contiene tabla de usuarios (%s); 0 usuarios por migrar.", src_table)
        return 0, True

    _, tgt_table = _has_auth_users(user_engine)

    with source_engine.connect() as src_conn:
        rows = src_conn.execute(
            text(
                f"SELECT CAST(id AS TEXT) AS id, name, email, password_hash, "
                f"created_at, updated_at FROM {src_table} ORDER BY created_at"
            )
        ).fetchall()

    migrated = 0
    with user_engine.begin() as tgt_conn:
        for row in rows:
            existing = tgt_conn.execute(
                text(
                    f"SELECT CAST(id AS TEXT) AS id, password_hash "
                    f"FROM {tgt_table} WHERE CAST(id AS TEXT) = :id"
                ),
                {"id": row.id},
            ).fetchone()

            if existing is None:
                tgt_conn.execute(
                    text(
                        f"INSERT INTO {tgt_table} "
                        f"(id, name, email, password_hash, created_at, updated_at) "
                        f"VALUES (:id, :name, :email, :password_hash, :created_at, :updated_at)"
                    ),
                    {
                        "id": row.id,
                        "name": row.name,
                        "email": row.email.lower(),
                        "password_hash": row.password_hash,
                        "created_at": row.created_at,
                        "updated_at": row.updated_at,
                    },
                )
            else:
                tgt_conn.execute(
                    text(
                        f"UPDATE {tgt_table} "
                        f"SET name = :name, email = :email, password_hash = :password_hash, "
                        f"updated_at = :updated_at WHERE CAST(id AS TEXT) = :id"
                    ),
                    {
                        "id": row.id,
                        "name": row.name,
                        "email": row.email.lower(),
                        "password_hash": row.password_hash,
                        "updated_at": row.updated_at,
                    },
                )
            migrated += 1

    # Verificación de integridad (conteo, UUID y hash idéntico)
    with user_engine.connect() as tgt_conn:
        for row in rows:
            chk = tgt_conn.execute(
                text(
                    f"SELECT CAST(id AS TEXT) AS id, email, password_hash "
                    f"FROM {tgt_table} WHERE CAST(id AS TEXT) = :id"
                ),
                {"id": row.id},
            ).fetchone()
            if chk is None or chk.id != row.id or chk.password_hash != row.password_hash:
                log.error("Discrepancia en usuario migrado %s", row.id)
                return migrated, False

    log.info("Usuarios migrados y verificados en UserDB: %d/%d", migrated, len(rows))
    return migrated, True


def migrate_boards(source_engine, board_engine) -> tuple[dict[str, int], bool]:
    """Copia boards, board_members y board_invites desde P1 hacia BoardDB."""
    BoardBase.metadata.create_all(bind=board_engine)

    insp = inspect(source_engine)
    src_tables = set(insp.get_table_names())
    counts = {"boards": 0, "board_members": 0, "board_invites": 0}
    if "boards" not in src_tables:
        log.info("Origen no contiene tabla boards; nada que migrar a BoardDB.")
        return counts, True

    TargetSession = sessionmaker(bind=board_engine)
    now = datetime.now(UTC)

    with source_engine.connect() as src_conn, TargetSession() as tgt_db:
        board_cols = {c["name"] for c in insp.get_columns("boards")}
        has_status = "status" in board_cols
        sql_boards = (
            "SELECT id, name, owner_id, status, created_at, updated_at FROM boards"
            if has_status
            else "SELECT id, name, owner_id, created_at, updated_at FROM boards"
        )
        src_boards = src_conn.execute(text(sql_boards)).fetchall()

        for b in src_boards:
            status_val = getattr(b, "status", None) or BoardStatus.active.value
            existing = tgt_db.get(Board, b.id)
            if existing is None:
                tgt_db.add(
                    Board(
                        id=b.id,
                        name=b.name,
                        owner_id=b.owner_id,
                        status=status_val,
                        created_at=_as_dt(b.created_at, now),
                        updated_at=_as_dt(b.updated_at, now),
                    )
                )
            else:
                existing.name = b.name
                existing.owner_id = b.owner_id
                existing.status = status_val
            counts["boards"] += 1
        tgt_db.commit()

        if "board_members" in src_tables:
            src_members = src_conn.execute(
                text(
                    "SELECT board_id, user_id, display_name, role, joined_at "
                    "FROM board_members ORDER BY id"
                )
            ).fetchall()
            for m in src_members:
                if tgt_db.get(Board, m.board_id) is None:
                    continue
                existing_m = tgt_db.scalar(
                    select(BoardMember).where(
                        BoardMember.board_id == m.board_id,
                        BoardMember.user_id == m.user_id,
                    )
                )
                role_enum = Role(str(m.role))
                if existing_m is None:
                    tgt_db.add(
                        BoardMember(
                            board_id=m.board_id,
                            user_id=m.user_id,
                            display_name=m.display_name,
                            role=role_enum,
                            joined_at=_as_dt(m.joined_at, now),
                        )
                    )
                else:
                    existing_m.display_name = m.display_name
                    existing_m.role = role_enum
                counts["board_members"] += 1
            tgt_db.commit()

        if "board_invites" in src_tables:
            src_invites = src_conn.execute(
                text(
                    "SELECT id, token, board_id, role, created_by, created_at, "
                    "expires_at, revoked, uses FROM board_invites"
                )
            ).fetchall()
            for inv in src_invites:
                if tgt_db.get(Board, inv.board_id) is None:
                    continue
                existing_i = tgt_db.get(Invite, inv.id)
                role_enum = Role(str(inv.role))
                if existing_i is None:
                    tgt_db.add(
                        Invite(
                            id=inv.id,
                            token=inv.token,
                            board_id=inv.board_id,
                            role=role_enum,
                            created_by=inv.created_by,
                            created_at=_as_dt(inv.created_at, now),
                            expires_at=_as_dt(inv.expires_at, None),
                            revoked=bool(inv.revoked),
                            uses=int(inv.uses or 0),
                        )
                    )
                else:
                    existing_i.token = inv.token
                    existing_i.role = role_enum
                    existing_i.revoked = bool(inv.revoked)
                    existing_i.uses = int(inv.uses or 0)
                counts["board_invites"] += 1
            tgt_db.commit()

        # Verificación de cantidades
        tgt_boards_count = tgt_db.query(Board).count()
        if tgt_boards_count < counts["boards"]:
            log.error("Faltan tableros en BoardDB (%d < %d)", tgt_boards_count, counts["boards"])
            return counts, False

    log.info(
        " Colaboración migrada y verificada en BoardDB: %d boards, %d members, %d invites",
        counts["boards"],
        counts["board_members"],
        counts["board_invites"],
    )
    return counts, True


def migrate_all(source_url: str, user_db_url: str, board_db_url: str) -> bool:
    log.info("Iniciando migración P1 -> UserDB + BoardDB (P2)")
    src_engine = create_engine(source_url)
    user_engine = create_engine(user_db_url)
    board_engine = create_engine(board_db_url)

    _, ok_users = migrate_users(src_engine, user_engine)
    _, ok_boards = migrate_boards(src_engine, board_engine)
    return ok_users and ok_boards


def main() -> None:
    parser = argparse.ArgumentParser(description="Migración P1 a UserDB y BoardDB")
    parser.add_argument(
        "--source-url",
        default=os.getenv(
            "P1_DATABASE_URL", "postgresql+psycopg://postgres:postgres@localhost:5432/pizarra"
        ),
        help="URL de base de datos origen (P1)",
    )
    parser.add_argument(
        "--user-db-url",
        default=os.getenv(
            "USER_DATABASE_URL", "postgresql+psycopg://postgres:postgres@localhost:5435/users"
        ),
        help="URL de destino para UserDB (Auth)",
    )
    parser.add_argument(
        "--board-db-url",
        default=os.getenv(
            "BOARD_DATABASE_URL", "postgresql+psycopg://postgres:postgres@localhost:5433/boards"
        ),
        help="URL de destino para BoardDB (Colaboración)",
    )
    args = parser.parse_args()
    sys.exit(0 if migrate_all(args.source_url, args.user_db_url, args.board_db_url) else 1)


if __name__ == "__main__":
    main()
