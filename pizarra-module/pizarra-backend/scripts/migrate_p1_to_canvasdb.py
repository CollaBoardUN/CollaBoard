#!/usr/bin/env python3
"""Script de migración de P1 a CanvasDB (P2) - CollaBoard.

Transfiere estados actuales (board_states) e historial de versiones (board_versions)
desde la base de datos de P1 (pizarra) hacia la nueva CanvasDB aislada (canvas)
sin alterar ningún dato de origen y verificando exhaustivamente la consistencia de hashes.

Uso:
    python scripts/migrate_p1_to_canvasdb.py \\
        --source-url postgresql+psycopg://postgres:postgres@localhost:5432/pizarra \\
        --target-url postgresql+psycopg://postgres:postgres@localhost:5432/canvas
"""

import argparse
import hashlib
import json
import logging
import os
import sys
from datetime import datetime
from pathlib import Path

# Asegurar app en el PYTHONPATH
BACKEND_DIR = Path(__file__).resolve().parent.parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from sqlalchemy import create_engine, select, text
from sqlalchemy.orm import sessionmaker

from app.persistence.models import BoardState, BoardVersion, PurgedBoard
from app.persistence.store import state_hash

logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] %(levelname)s - %(message)s",
)
log = logging.getLogger("migrator")


def compute_hash(elements: list[dict]) -> str:
    raw = json.dumps(elements, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(raw.encode()).hexdigest()


def migrate(source_url: str, target_url: str) -> bool:
    log.info("Iniciando migración P1 -> CanvasDB (P2)")
    log.info("Origen (P1): %s", source_url)
    log.info("Destino (CanvasDB): %s", target_url)

    source_engine = create_engine(source_url)
    target_engine = create_engine(target_url)

    # Asegurar que las tablas existan en destino
    BoardState.__table__.create(bind=target_engine, checkfirst=True)
    BoardVersion.__table__.create(bind=target_engine, checkfirst=True)
    PurgedBoard.__table__.create(bind=target_engine, checkfirst=True)

    SourceSession = sessionmaker(bind=source_engine)
    TargetSession = sessionmaker(bind=target_engine)

    with SourceSession() as src_db, TargetSession() as tgt_db:
        # 1. Migrar board_states
        log.info("Leyendo board_states desde origen...")
        source_states = src_db.execute(
            text(
                "SELECT board_id, elements, seq, element_count, "
                "COALESCE(content_hash, '') as chash, thumbnail_svg, thumbnail_at, saved_at "
                "FROM board_states"
            )
        ).fetchall()

        states_migrated = 0
        states_verified = 0

        for row in source_states:
            board_id = row.board_id
            elements = row.elements if isinstance(row.elements, list) else json.loads(row.elements or "[]")
            source_hash = compute_hash(elements)

            if row.chash and row.chash != source_hash:
                log.warning("Discrepancia en origen para board_state %s: guardado=%s, calculado=%s",
                            board_id, row.chash, source_hash)

            # Insertar o actualizar en CanvasDB
            existing = tgt_db.get(BoardState, board_id)
            if existing is None:
                existing = BoardState(
                    board_id=board_id,
                    elements=elements,
                    seq=row.seq,
                    element_count=len(elements),
                    state_hash=source_hash,
                    thumbnail_svg=row.thumbnail_svg,
                    thumbnail_at=row.thumbnail_at,
                    saved_at=row.saved_at,
                    is_deleted=False,
                )
                tgt_db.add(existing)
            else:
                existing.elements = elements
                existing.seq = max(existing.seq, row.seq)
                existing.element_count = len(elements)
                existing.state_hash = source_hash
                existing.thumbnail_svg = row.thumbnail_svg
                existing.thumbnail_at = row.thumbnail_at
                existing.saved_at = row.saved_at

            tgt_db.commit()
            states_migrated += 1

            # Verificación inmediata de consistencia
            tgt_state = tgt_db.get(BoardState, board_id)
            target_hash = compute_hash(tgt_state.elements)
            if target_hash != source_hash:
                log.error("ERROR CRÍTICO: El hash en destino para board_state %s no coincide! (src: %s, tgt: %s)",
                          board_id, source_hash, target_hash)
                return False
            states_verified += 1

        log.info("Estados migrados y verificados: %d/%d", states_verified, len(source_states))

        # 2. Migrar board_versions
        log.info("Leyendo board_versions desde origen...")
        source_versions = src_db.execute(
            text(
                "SELECT id, board_id, number, kind, name, created_by, created_by_name, "
                "created_at, seq, element_count, COALESCE(content_hash, '') as chash, elements "
                "FROM board_versions ORDER BY board_id, number"
            )
        ).fetchall()

        versions_migrated = 0
        versions_verified = 0

        for row in source_versions:
            v_id = row.id
            elements = row.elements if isinstance(row.elements, list) else json.loads(row.elements or "[]")
            source_hash = compute_hash(elements)

            existing_v = tgt_db.get(BoardVersion, v_id)
            if existing_v is None:
                existing_v = BoardVersion(
                    id=v_id,
                    board_id=row.board_id,
                    number=row.number,
                    kind=row.kind,
                    name=row.name,
                    created_by=row.created_by,
                    created_by_name=row.created_by_name,
                    created_at=row.created_at,
                    seq=row.seq,
                    element_count=len(elements),
                    state_hash=source_hash,
                    elements=elements,
                )
                tgt_db.add(existing_v)
            else:
                existing_v.state_hash = source_hash
                existing_v.elements = elements

            tgt_db.commit()
            versions_migrated += 1

            tgt_v = tgt_db.get(BoardVersion, v_id)
            target_hash = compute_hash(tgt_v.elements)
            if target_hash != source_hash:
                log.error("ERROR CRÍTICO: El hash en destino para board_version %s no coincide!", v_id)
                return False
            versions_verified += 1

        log.info("Versiones migradas y verificadas: %d/%d", versions_verified, len(source_versions))

    log.info("==================================================")
    log.info("MIGRACIÓN COMPLETADA EXITOSAMENTE:")
    log.info("- %d estados de tablero transferidos y verificados (100%% integridad)", states_verified)
    log.info("- %d versiones de historial transferidas y verificadas (100%% integridad)", versions_verified)
    log.info("- Origen P1 intacto sin alteraciones.")
    log.info("==================================================")
    return True


def main():
    parser = argparse.ArgumentParser(description="Migración P1 a CanvasDB")
    parser.add_argument(
        "--source-url",
        default=os.getenv("P1_DATABASE_URL", "postgresql+psycopg://postgres:postgres@localhost:5432/pizarra"),
        help="URL de base de datos origen (P1)",
    )
    parser.add_argument(
        "--target-url",
        default=os.getenv("CANVAS_DATABASE_URL", "postgresql+psycopg://postgres:postgres@localhost:5432/canvas"),
        help="URL de base de datos destino (CanvasDB)",
    )
    args = parser.parse_args()

    success = migrate(args.source_url, args.target_url)
    sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()
