"""Pruebas del script de migración P1 -> UserDB + BoardDB y propiedad de esquemas."""

import importlib.util
import os
import tempfile
from datetime import UTC, datetime
from pathlib import Path

from sqlalchemy import create_engine, inspect, text

from app.database import Base


def _load_migrator():
    script_path = (
        Path(__file__).resolve().parents[2] / "scripts" / "migrate_p1_to_userdb_boarddb.py"
    )
    spec = importlib.util.spec_from_file_location("migrate_p1_to_userdb_boarddb", script_path)
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


def test_board_db_no_contiene_tablas_de_canvas_ni_usuarios():
    """Verifica que el modelo de Colaboración sea dueño exclusivo de BoardDB."""
    tables = set(Base.metadata.tables.keys())
    assert tables == {"boards", "board_members", "board_invites", "outbox_events"}
    assert "board_states" not in tables
    assert "board_versions" not in tables
    assert "users" not in tables


def test_migracion_separa_userdb_y_boarddb_sin_cambiar_uuids_ni_hashes():
    migrator = _load_migrator()
    tmp = tempfile.mkdtemp()
    src_url = f"sqlite:///{os.path.join(tmp, 'p1_shared.db')}"
    user_url = f"sqlite:///{os.path.join(tmp, 'user_db.db')}"
    board_url = f"sqlite:///{os.path.join(tmp, 'board_db.db')}"

    src_engine = create_engine(src_url)
    now_iso = datetime.now(UTC).isoformat()
    argon_hash = "$argon2id$v=19$m=65536,t=3,p=2$c2FsdHNhbHQ$aGFzaGhhc2hoYXNo"
    user_uuid = "550e8400-e29b-41d4-a716-446655440000"
    board_uuid = "31b6cc68-118d-4195-8490-940203f8e18d"
    invite_uuid = "9a10b220-1111-4222-8333-444455556666"

    with src_engine.begin() as conn:
        conn.execute(
            text(
                """
                CREATE TABLE auth_users (
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
        conn.execute(
            text(
                "INSERT INTO auth_users (id, name, email, password_hash, created_at, updated_at) "
                "VALUES (:id, :name, :email, :hash, :now, :now)"
            ),
            {
                "id": user_uuid,
                "name": "Ana Gómez",
                "email": "ana@example.com",
                "hash": argon_hash,
                "now": now_iso,
            },
        )
        conn.execute(
            text(
                """
                CREATE TABLE boards (
                    id TEXT PRIMARY KEY,
                    name VARCHAR(120) NOT NULL,
                    owner_id VARCHAR(64) NOT NULL,
                    created_at TIMESTAMP NOT NULL,
                    updated_at TIMESTAMP NOT NULL
                )
                """
            )
        )
        conn.execute(
            text(
                "INSERT INTO boards (id, name, owner_id, created_at, updated_at) "
                "VALUES (:id, 'Arquitectura P1', :owner, :now, :now)"
            ),
            {"id": board_uuid, "owner": user_uuid, "now": now_iso},
        )
        conn.execute(
            text(
                """
                CREATE TABLE board_members (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    board_id TEXT NOT NULL,
                    user_id TEXT NOT NULL,
                    display_name TEXT,
                    role TEXT NOT NULL,
                    joined_at TIMESTAMP NOT NULL
                )
                """
            )
        )
        conn.execute(
            text(
                "INSERT INTO board_members (board_id, user_id, display_name, role, joined_at) "
                "VALUES (:b, :u, 'Ana Gómez', 'owner', :now)"
            ),
            {"b": board_uuid, "u": user_uuid, "now": now_iso},
        )
        conn.execute(
            text(
                """
                CREATE TABLE board_invites (
                    id TEXT PRIMARY KEY,
                    token TEXT NOT NULL UNIQUE,
                    board_id TEXT NOT NULL,
                    role TEXT NOT NULL,
                    created_by TEXT NOT NULL,
                    created_at TIMESTAMP NOT NULL,
                    expires_at TIMESTAMP,
                    revoked BOOLEAN NOT NULL,
                    uses INTEGER NOT NULL
                )
                """
            )
        )
        conn.execute(
            text(
                "INSERT INTO board_invites "
                "(id, token, board_id, role, created_by, created_at, expires_at, revoked, uses) "
                "VALUES (:id, 'tok-p1-123', :b, 'editor', :u, :now, NULL, 0, 2)"
            ),
            {"id": invite_uuid, "b": board_uuid, "u": user_uuid, "now": now_iso},
        )

    # Ejecutar dos veces para demostrar que es repetible/idempotente
    assert migrator.migrate_all(src_url, user_url, board_url) is True
    assert migrator.migrate_all(src_url, user_url, board_url) is True

    user_engine = create_engine(user_url)
    with user_engine.connect() as conn:
        row = conn.execute(
            text("SELECT id, email, password_hash FROM auth_users WHERE id = :id"),
            {"id": user_uuid},
        ).fetchone()
        assert row is not None
        assert row.id == user_uuid
        assert row.email == "ana@example.com"
        assert row.password_hash == argon_hash

    board_engine = create_engine(board_url)
    assert "auth_users" not in inspect(board_engine).get_table_names()
    with board_engine.connect() as conn:
        b = conn.execute(
            text("SELECT id, name, owner_id, status FROM boards WHERE id = :id"),
            {"id": board_uuid},
        ).fetchone()
        assert b is not None
        assert b.id == board_uuid
        assert b.owner_id == user_uuid
        assert b.status == "active"

        inv = conn.execute(
            text("SELECT id, token, uses FROM board_invites WHERE id = :id"),
            {"id": invite_uuid},
        ).fetchone()
        assert inv is not None
        assert inv.token == "tok-p1-123"
        assert inv.uses == 2
