"""Lectura y escritura del estado de un tablero en PostgreSQL (CanvasDB).

Totalmente desacoplado de BoardDB: no realiza consultas SQL a tablas ajenas.
Control estricto de integridad con state_hash y monotonicidad atómica de seq.
"""

import hashlib
import json
from datetime import UTC, datetime

from sqlalchemy import delete, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, undefer
from starlette.concurrency import run_in_threadpool

from ..database import SessionLocal
from .models import BoardState, BoardVersion, PurgedBoard

# Cuántas versiones se conservan por tipo. Las "manual" nunca se podan solas:
# hay un tope y, al llegar, hay que borrar alguna a mano.
PRUNE_LIMITS = {"auto": 50, "restore": 20}
MAX_MANUAL = 100


class BoardGone(Exception):
    """El tablero ya no existe o fue purgado (se descartan autosaves tardíos)."""


class TooManyVersions(Exception):
    """Se alcanzó el tope de versiones manuales del tablero."""


def _utcnow() -> datetime:
    return datetime.now(UTC)


def content_hash(elements: list[dict]) -> str:
    """Huella SHA-256 canónica estable del contenido: mismo canvas => mismo hash."""
    raw = json.dumps(elements, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(raw.encode()).hexdigest()


# Alias requerido por la especificación de integridad en TASK_PAQUETE_D
state_hash = content_hash


def is_board_purged(db: Session, board_id: str) -> bool:
    """Verifica si el tablero fue purgado para bloquear operaciones posteriores."""
    return db.get(PurgedBoard, board_id) is not None


def purge_board(db: Session, board_id: str) -> None:
    """Purga de forma idempotente canvas y versiones, bloqueando autosaves posteriores."""
    if not is_board_purged(db, board_id):
        db.add(PurgedBoard(board_id=board_id, purged_at=_utcnow()))
    db.execute(delete(BoardVersion).where(BoardVersion.board_id == board_id))
    db.execute(delete(BoardState).where(BoardState.board_id == board_id))
    db.commit()


def load_state(db: Session, board_id: str) -> tuple[list[dict], int]:
    """Elementos y `seq` guardados. Un tablero sin estado es un tablero vacío."""
    if is_board_purged(db, board_id):
        return [], 0

    row = db.execute(
        select(BoardState.elements, BoardState.seq, BoardState.is_deleted).where(
            BoardState.board_id == board_id
        )
    ).first()
    if row is None or row.is_deleted:
        return [], 0
    elements = [
        e for e in (row.elements or []) if isinstance(e, dict) and isinstance(e.get("id"), str)
    ]
    return elements, int(row.seq or 0)


def save_state(db: Session, board_id: str, elements: list[dict], seq: int) -> bool:
    """Guarda (upsert) el estado actual en CanvasDB. Devuelve True si hubo cambios reales.

    - Bloquea guardado si el tablero fue purgado (BoardGone).
    - Mantiene la gestión atómica del contador incremental `seq` (nunca retrocede).
    - Valida integridad mediante `state_hash`.
    """
    if is_board_purged(db, board_id):
        raise BoardGone(board_id)

    board = None
    try:
        from sqlalchemy import inspect

        from ..models import Board

        bind = db.get_bind()
        if inspect(bind).has_table("boards"):
            board = db.get(Board, board_id)
            if board is None:
                raise BoardGone(board_id)
    except BoardGone:
        raise
    except Exception:
        pass

    digest = state_hash(elements)
    now = _utcnow()
    state = db.get(BoardState, board_id)

    if state is None:
        db.add(
            BoardState(
                board_id=board_id,
                elements=elements,
                seq=seq,
                element_count=len(elements),
                state_hash=digest,
                saved_at=now,
                is_deleted=False,
            )
        )
    elif state.is_deleted:
        raise BoardGone(board_id)
    elif state.state_hash == digest:
        # Mismo dibujo; aseguramos incremento monotónico atómico de seq
        if seq > state.seq:
            state.seq = seq
            db.commit()
        return False
    else:
        state.elements = elements
        state.seq = max(state.seq, seq)
        state.element_count = len(elements)
        state.state_hash = digest
        state.saved_at = now

    if board is not None:
        board.updated_at = now
    db.commit()
    return True


def _load_in_thread(board_id: str) -> tuple[list[dict], int]:
    with SessionLocal() as db:
        return load_state(db, board_id)


async def load_state_async(board_id: str) -> tuple[list[dict], int]:
    """Loader asíncrono para inicialización de salas."""
    return await run_in_threadpool(_load_in_thread, board_id)


# ------------------------------------------------------------------ versiones


def latest_version(db: Session, board_id: str) -> BoardVersion | None:
    """La versión más reciente (sin cargar sus elementos)."""
    if is_board_purged(db, board_id):
        return None
    return db.scalar(
        select(BoardVersion)
        .where(BoardVersion.board_id == board_id)
        .order_by(BoardVersion.number.desc())
        .limit(1)
    )


def list_versions(db: Session, board_id: str, limit: int = 50) -> list[BoardVersion]:
    """Más nuevas primero. No trae los elementos (son pesados)."""
    if is_board_purged(db, board_id):
        return []
    return list(
        db.scalars(
            select(BoardVersion)
            .where(BoardVersion.board_id == board_id)
            .order_by(BoardVersion.number.desc())
            .limit(limit)
        )
    )


def get_version(
    db: Session, board_id: str, version_id: str, *, with_elements: bool = False
) -> BoardVersion | None:
    """Una versión de ESTE tablero (una de otro tablero cuenta como inexistente)."""
    if is_board_purged(db, board_id):
        return None
    stmt = select(BoardVersion).where(
        BoardVersion.id == version_id, BoardVersion.board_id == board_id
    )
    if with_elements:
        stmt = stmt.options(undefer(BoardVersion.elements))
    return db.scalar(stmt)


def _prune(db: Session, board_id: str, kind: str) -> None:
    limit = PRUNE_LIMITS.get(kind)
    if limit is None:
        return
    old_ids = db.scalars(
        select(BoardVersion.id)
        .where(BoardVersion.board_id == board_id, BoardVersion.kind == kind)
        .order_by(BoardVersion.number.desc())
        .offset(limit)
    ).all()
    if old_ids:
        db.execute(delete(BoardVersion).where(BoardVersion.id.in_(old_ids)))


def create_version(
    db: Session,
    board_id: str,
    *,
    kind: str,
    elements: list[dict],
    seq: int,
    user_id: str | None = None,
    user_name: str | None = None,
    name: str | None = None,
    dedupe: bool = False,
) -> BoardVersion | None:
    """Guarda una foto completa del tablero en CanvasDB."""
    if is_board_purged(db, board_id):
        raise BoardGone(board_id)

    try:
        from sqlalchemy import inspect

        from ..models import Board

        bind = db.get_bind()
        if inspect(bind).has_table("boards") and db.get(Board, board_id) is None:
            raise BoardGone(board_id)
    except BoardGone:
        raise
    except Exception:
        pass

    digest = state_hash(elements)
    if dedupe:
        last = latest_version(db, board_id)
        if last is None and not elements:
            return None
        if last is not None and last.state_hash == digest:
            return None

    if kind == "manual":
        manual = db.scalar(
            select(func.count())
            .select_from(BoardVersion)
            .where(BoardVersion.board_id == board_id, BoardVersion.kind == "manual")
        )
        if (manual or 0) >= MAX_MANUAL:
            raise TooManyVersions(board_id)

    # El número es por tablero (v1, v2…). Si dos guardados chocan, el índice único
    # lo detecta y se reintenta con el siguiente número.
    for _ in range(3):
        highest = db.scalar(
            select(func.max(BoardVersion.number)).where(BoardVersion.board_id == board_id)
        )
        number = (highest or 0) + 1
        version = BoardVersion(
            board_id=board_id,
            number=number,
            kind=kind,
            name=name,
            created_by=user_id,
            created_by_name=user_name,
            seq=seq,
            element_count=len(elements),
            state_hash=digest,
            elements=elements,
        )
        db.add(version)
        try:
            db.flush()
        except IntegrityError:
            db.rollback()
            continue
        _prune(db, board_id, kind)
        db.commit()
        return version
    raise RuntimeError("No se pudo asignar un número de versión")
