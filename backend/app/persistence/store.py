"""Lectura y escritura del estado de un tablero en PostgreSQL.

Funciones síncronas (reciben una `Session`) y una versión async para el loader
de la sala, que corre la consulta en un hilo para no bloquear el event loop.
"""

import hashlib
import json

from sqlalchemy import delete, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, undefer
from starlette.concurrency import run_in_threadpool

from ..database import SessionLocal
from ..models import Board, utcnow
from .models import BoardState, BoardVersion

# Cuántas versiones se conservan por tipo. Las "manual" nunca se podan solas:
# hay un tope y, al llegar, hay que borrar alguna a mano.
PRUNE_LIMITS = {"auto": 50, "restore": 20}
MAX_MANUAL = 100


class BoardGone(Exception):
    """El tablero ya no existe (lo borraron mientras había cambios por guardar)."""


class TooManyVersions(Exception):
    """Se alcanzó el tope de versiones manuales del tablero."""


def content_hash(elements: list[dict]) -> str:
    """Huella estable del contenido: mismo tablero => mismo hash."""
    raw = json.dumps(elements, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(raw.encode()).hexdigest()


def load_state(db: Session, board_id: str) -> tuple[list[dict], int]:
    """Elementos y `seq` guardados. Un tablero sin estado es un tablero vacío."""
    row = db.execute(
        select(BoardState.elements, BoardState.seq).where(BoardState.board_id == board_id)
    ).first()
    if row is None:
        return [], 0
    elements = [
        e for e in (row.elements or []) if isinstance(e, dict) and isinstance(e.get("id"), str)
    ]
    return elements, int(row.seq or 0)


def save_state(db: Session, board_id: str, elements: list[dict], seq: int) -> bool:
    """Guarda (upsert) el estado actual. Devuelve True si hubo cambios reales.

    `elements` debe ser una COPIA tomada bajo el candado de la sala: aquí se
    serializa fuera de él.
    Lanza `BoardGone` si el tablero ya no existe.
    """
    board = db.get(Board, board_id)
    if board is None:
        raise BoardGone(board_id)

    digest = content_hash(elements)
    now = utcnow()
    state = db.get(BoardState, board_id)

    if state is None:
        db.add(
            BoardState(
                board_id=board_id,
                elements=elements,
                seq=seq,
                element_count=len(elements),
                content_hash=digest,
                saved_at=now,
            )
        )
    elif state.content_hash == digest:
        if state.seq != seq:  # mismo dibujo; solo mantenemos el seq al día
            state.seq = seq
            db.commit()
        return False
    else:
        state.elements = elements
        state.seq = seq
        state.element_count = len(elements)
        state.content_hash = digest
        state.saved_at = now

    board.updated_at = now  # el dashboard ordena por esto y muestra "editado hace…"
    db.commit()
    return True


def _load_in_thread(board_id: str) -> tuple[list[dict], int]:
    with SessionLocal() as db:
        return load_state(db, board_id)


async def load_state_async(board_id: str) -> tuple[list[dict], int]:
    """Loader que se enchufa en `manager.loader` (ver realtime/rooms.py)."""
    return await run_in_threadpool(_load_in_thread, board_id)


# ------------------------------------------------------------------ versiones


def latest_version(db: Session, board_id: str) -> BoardVersion | None:
    """La versión más reciente (sin cargar sus elementos)."""
    return db.scalar(
        select(BoardVersion)
        .where(BoardVersion.board_id == board_id)
        .order_by(BoardVersion.number.desc())
        .limit(1)
    )


def list_versions(db: Session, board_id: str, limit: int = 50) -> list[BoardVersion]:
    """Más nuevas primero. No trae los elementos (son pesados)."""
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
    """Guarda una foto completa del tablero.

    Con `dedupe=True` no crea nada (devuelve None) si el contenido es idéntico al
    de la última versión, o si el tablero está vacío y no hay versiones todavía.
    Lanza `BoardGone` si el tablero no existe y `TooManyVersions` si se llegó al
    tope de versiones manuales.
    """
    if db.get(Board, board_id) is None:
        raise BoardGone(board_id)

    digest = content_hash(elements)
    if dedupe:
        last = latest_version(db, board_id)
        if last is None and not elements:
            return None
        if last is not None and last.content_hash == digest:
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
        number = (
            db.scalar(
                select(func.max(BoardVersion.number)).where(BoardVersion.board_id == board_id)
            )
            or 0
        ) + 1
        version = BoardVersion(
            board_id=board_id,
            number=number,
            kind=kind,
            name=name,
            created_by=user_id,
            created_by_name=user_name,
            seq=seq,
            element_count=len(elements),
            content_hash=digest,
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
