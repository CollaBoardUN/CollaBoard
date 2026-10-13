"""Operaciones de versiones que tocan la sala en vivo: crear una desde el estado
actual y restaurar una versión.

Van aparte del router porque deben coordinarse con las personas conectadas y con
el autosave. Orden de candados (siempre el mismo, para no bloquearse):
    candado de escritura del tablero (autosave)  ->  candado de la sala
"""

from datetime import UTC, datetime

from sqlalchemy import select
from starlette.concurrency import run_in_threadpool

from ..auth import CurrentUser
from ..database import SessionLocal
from ..realtime.rooms import Room, manager
from .autosave import autosaver
from .models import BoardState
from .schemas import VersionOut
from .store import (
    create_version,
    get_version,
    latest_version,
    load_state_async,
    save_state,
)


class VersionNotFound(Exception):
    pass


def _copy(room: Room) -> list[dict]:
    return [dict(e) for e in room.elements.values()]


# ------------------------------------------------------------------ estado


async def current_state(board_id: str) -> tuple[list[dict], int, datetime | None]:
    """Estado más reciente: el de la sala si está activa, si no el guardado."""
    room = manager.rooms.get(board_id)
    if room is not None and room.loaded:
        async with room.lock:
            elements, seq = _copy(room), room.seq
    else:
        elements, seq = await load_state_async(board_id)
    return elements, seq, await run_in_threadpool(_saved_at, board_id)


def _saved_at(board_id: str) -> datetime | None:
    with SessionLocal() as db:
        return db.scalar(select(BoardState.saved_at).where(BoardState.board_id == board_id))


# ------------------------------------------------------------------ crear


def _create_manual(
    board_id: str, elements: list[dict], seq: int, user: CurrentUser, name: str | None
) -> VersionOut:
    with SessionLocal() as db:
        version = create_version(
            db,
            board_id,
            kind="manual",
            elements=elements,
            seq=seq,
            user_id=user.id,
            user_name=user.display_name,
            name=name,
        )
        return VersionOut.model_validate(version)


async def create_manual_version(board_id: str, user: CurrentUser, name: str | None) -> VersionOut:
    """Versión manual con lo que hay AHORA en el tablero (no con lo último guardado)."""
    room = manager.get(board_id)
    try:
        await manager.ensure_loaded(room)
        await autosaver.flush(room)  # que la base de datos y la versión coincidan
        async with room.lock:
            elements, seq = _copy(room), room.seq
    finally:
        manager.release(room)
    return await run_in_threadpool(_create_manual, board_id, elements, seq, user, name)


# ------------------------------------------------------------------ restaurar


def _load_for_restore(board_id: str, version_id: str) -> tuple[VersionOut, list[dict]] | None:
    with SessionLocal() as db:
        version = get_version(db, board_id, version_id, with_elements=True)
        if version is None:
            return None
        return VersionOut.model_validate(version), list(version.elements)


def _backup(
    board_id: str, elements: list[dict], seq: int, user: CurrentUser, target_number: int
) -> VersionOut | None:
    with SessionLocal() as db:
        version = create_version(
            db,
            board_id,
            kind="restore",
            elements=elements,
            seq=seq,
            user_id=user.id,
            user_name=user.display_name,
            name=f"Antes de restaurar v{target_number}",
            dedupe=True,
        ) or latest_version(db, board_id)
        return VersionOut.model_validate(version) if version else None


def _persist(board_id: str, elements: list[dict], seq: int) -> None:
    with SessionLocal() as db:
        save_state(db, board_id, elements, seq)


async def restore_version(
    board_id: str, version_id: str, user: CurrentUser
) -> tuple[VersionOut, VersionOut | None, int]:
    """Reemplaza el tablero (en vivo y en la base de datos) por una versión.

    1. Guarda el estado actual como versión "restore" (así restaurar se puede deshacer).
    2. Escribe la versión elegida en la base de datos.
    3. Solo si eso salió bien, cambia la sala y avisa a todos: `restored` y un
       `sync` con el tablero completo. El `sync` hace que cada navegador reemplace
       su tablero y reinicie su historial de deshacer.

    Lanza `VersionNotFound`, `BoardGone` (tablero borrado) o el error de la base.
    """
    room = manager.get(board_id)
    try:
        await manager.ensure_loaded(room)
        loaded = await run_in_threadpool(_load_for_restore, board_id, version_id)
        if loaded is None:
            raise VersionNotFound(version_id)
        target, target_elements = loaded

        async with autosaver.board_lock(board_id), room.lock:
            backup = await run_in_threadpool(
                _backup, board_id, _copy(room), room.seq, user, target.number
            )
            restored = [dict(e) for e in target_elements]
            new_seq = room.seq + 1
            await run_in_threadpool(_persist, board_id, restored, new_seq)

            room.elements = {e["id"]: e for e in restored}
            room.seq = new_seq
            await _announce(room, target, user, new_seq)
        return target, backup, new_seq
    finally:
        manager.release(room)


async def _announce(room: Room, version: VersionOut, user: CurrentUser, seq: int) -> None:
    await room.broadcast(
        {
            "type": "restored",
            "version": {"id": version.id, "number": version.number, "name": version.name},
            "by": user.display_name or user.id,
        }
    )
    for conn in list(room.connections.values()):
        await conn.send(room.sync_message(conn))
    await room.broadcast(
        {"type": "saved", "seq": seq, "saved_at": datetime.now(UTC).isoformat()}
    )
