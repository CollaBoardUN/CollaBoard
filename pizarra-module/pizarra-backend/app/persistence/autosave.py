"""Autosave: guarda el estado de cada sala en PostgreSQL sin bloquear el dibujo.

Cómo funciona
-------------
- `on_ops` se engancha a `manager.on_ops`. Corre BAJO el candado de la sala, así
  que no escribe nada: solo marca el tablero como "sucio" y agenda el guardado.
- Un guardado se hace `debounce` segundos después de la última operación (así
  un trazo largo = un solo guardado) y, como máximo, `max_wait` segundos después
  del primer cambio sin guardar (así dibujar sin parar tampoco lo aplaza para siempre).
- `flush(room)` toma una copia del estado bajo el candado, y la escribe en un
  hilo (la base de datos es síncrona). Después avisa a la sala:
      {"type": "saved", "seq": N, "saved_at": "..."}      guardado bien
      {"type": "save_error", "message": "..."}            falló; se reintenta solo
- Hay un guardado a la vez por tablero (candado propio), para que una copia
  vieja nunca pise a una nueva.
- Se fuerza un guardado final (`flush_final`) cuando sale la última persona de la
  sala (routers/ws.py) y se guarda todo lo pendiente al apagar el servidor
  (`flush_all`, en el `lifespan` de main.py).
- HISTORIAL: tras guardar se crea una versión "auto" si pasaron `snapshot_every`
  segundos desde la anterior, y siempre al salir la última persona (`final=True`).
  No se crea si el contenido es idéntico al de la última versión.

Limitación: igual que las salas, asume un solo proceso/worker.
"""

import asyncio
import logging
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from starlette.concurrency import run_in_threadpool

from ..config import (
    AUTOSAVE_DEBOUNCE_SECONDS,
    AUTOSAVE_MAX_WAIT_SECONDS,
    AUTOSAVE_SNAPSHOT_EVERY_SECONDS,
)
from ..database import SessionLocal
from ..realtime.rooms import Room, manager
from .store import BoardGone, create_version, save_state

log = logging.getLogger(__name__)

RETRY_SECONDS = 5.0


def save_in_thread(board_id: str, elements: list[dict], seq: int) -> bool:
    """Escribe en la base de datos con su propia sesión (corre en un hilo)."""
    with SessionLocal() as db:
        return save_state(db, board_id, elements, seq)


def auto_version_in_thread(board_id: str, elements: list[dict], seq: int) -> None:
    """Crea una versión automática (sin duplicar la última). Corre en un hilo."""
    with SessionLocal() as db:
        create_version(db, board_id, kind="auto", elements=elements, seq=seq, dedupe=True)


@dataclass
class _Pending:
    room: Room
    first_dirty: float  # cuándo cambió por primera vez desde el último guardado
    last_op: float  # cuándo llegó la última operación
    retry_at: float = 0.0  # no reintentar antes de esta hora (tras un fallo)


class Autosaver:
    def __init__(
        self,
        rooms_manager: Any,
        *,
        debounce: float = AUTOSAVE_DEBOUNCE_SECONDS,
        max_wait: float = AUTOSAVE_MAX_WAIT_SECONDS,
        retry: float = RETRY_SECONDS,
        snapshot_every: float = AUTOSAVE_SNAPSHOT_EVERY_SECONDS,
        save_fn: Callable[[str, list[dict], int], bool] = save_in_thread,
        version_fn: Callable[[str, list[dict], int], None] = auto_version_in_thread,
    ) -> None:
        self._manager = rooms_manager
        self.debounce = debounce
        self.max_wait = max_wait
        self.retry = retry
        self.snapshot_every = snapshot_every
        self.save_fn = save_fn
        self.version_fn = version_fn
        self._last_auto: dict[str, float] = {}  # última versión automática por tablero
        self._pending: dict[str, _Pending] = {}
        self._tasks: dict[str, asyncio.Task] = {}
        self._background: set[asyncio.Task] = set()  # guardados finales en curso
        self._locks: dict[str, asyncio.Lock] = {}
        self._closing = False

    # ------------------------------------------------------------ enganche

    async def on_ops(self, board_id: str, seq: int, ops: list[dict]) -> None:
        """Se llama por cada lote aplicado. Debe ser rápido: solo marca y agenda."""
        room = self._manager.rooms.get(board_id)
        if room is None:
            return
        now = time.monotonic()
        self._last_auto.setdefault(board_id, now)
        pending = self._pending.get(board_id)
        if pending is None:
            self._pending[board_id] = _Pending(room, first_dirty=now, last_op=now)
        else:
            pending.last_op = now
        self._ensure_task(board_id)

    def _ensure_task(self, board_id: str) -> None:
        if self._closing or board_id in self._tasks:
            return
        self._tasks[board_id] = asyncio.create_task(self._run(board_id))

    async def _run(self, board_id: str) -> None:
        """Espera hasta que toque guardar este tablero y lo guarda; repite si hay más."""
        try:
            while True:
                pending = self._pending.get(board_id)
                if pending is None:
                    return
                due = max(
                    min(pending.last_op + self.debounce, pending.first_dirty + self.max_wait),
                    pending.retry_at,
                )
                wait = due - time.monotonic()
                if wait > 0:
                    await asyncio.sleep(wait)
                    continue
                await self.flush(pending.room)
        finally:
            self._tasks.pop(board_id, None)

    # ------------------------------------------------------------ guardado

    def board_lock(self, board_id: str) -> asyncio.Lock:
        """Candado de escritura del tablero. Quien reemplace el estado (restaurar una
        versión) debe tomarlo ANTES que el candado de la sala, igual que `flush`."""
        return self._locks.setdefault(board_id, asyncio.Lock())

    async def flush(self, room: Room, *, final: bool = False) -> None:
        """Guarda ya los cambios pendientes de la sala (si los hay).

        `final=True` (salió la última persona): además crea una versión automática
        con el estado actual, aunque ya estuviera guardado.
        """
        board_id = room.board_id
        async with self.board_lock(board_id):
            pending = self._pending.pop(board_id, None)
            if pending is None and not final:
                return

            # Copia bajo el candado; se serializa fuera de él. Es seguro con una
            # copia superficial: las operaciones reemplazan los campos (incluida
            # la lista `points`), nunca los modifican por dentro.
            async with room.lock:
                elements = [dict(e) for e in room.elements.values()]
                seq = room.seq

            if pending is not None:
                try:
                    await run_in_threadpool(self.save_fn, board_id, elements, seq)
                except BoardGone:
                    log.warning("El tablero %s ya no existe; se descarta su estado", board_id)
                    return
                except asyncio.CancelledError:
                    # Nos apagan a mitad de guardado: lo dejamos pendiente para flush_all.
                    self._pending.setdefault(board_id, pending)
                    raise
                except Exception:
                    log.exception("Falló el autosave del tablero %s", board_id)
                    if board_id not in self._pending:  # si no llegaron cambios nuevos
                        pending.retry_at = time.monotonic() + self.retry
                        self._pending[board_id] = pending
                    self._ensure_task(board_id)
                    await room.broadcast(
                        {"type": "save_error", "message": "No se pudo guardar. Reintentando…"}
                    )
                    return

            await self._maybe_snapshot(board_id, elements, seq, final)

        if pending is not None:
            await room.broadcast(
                {"type": "saved", "seq": seq, "saved_at": datetime.now(UTC).isoformat()}
            )

    async def flush_final(self, room: Room) -> None:
        """Guardado final de una sala que se quedó vacía (incluye la versión automática).

        Corre en su propia tarea y se espera con `shield`: si quien llama es cancelado,
        el guardado y la versión terminan igual en segundo plano. Hace falta porque el
        manejador del WebSocket SÍ se cancela al desconectarse el cliente en algunos
        servidores y en el `TestClient` de Starlette, y una cancelación a mitad de
        camino dejaba el estado guardado pero sin la versión.
        """
        task = asyncio.create_task(self.flush(room, final=True))
        self._background.add(task)
        task.add_done_callback(self._background_done)
        await asyncio.shield(task)

    def _background_done(self, task: asyncio.Task) -> None:
        self._background.discard(task)
        if not task.cancelled():
            task.exception()  # lo marca como leído: `flush` ya registra sus propios errores

    async def _maybe_snapshot(
        self, board_id: str, elements: list[dict], seq: int, final: bool
    ) -> None:
        now = time.monotonic()
        due = now - self._last_auto.get(board_id, now) >= self.snapshot_every
        if not (final or due):
            return
        try:
            await run_in_threadpool(self.version_fn, board_id, elements, seq)
        except BoardGone:
            return
        except Exception:  # el historial es secundario: nunca debe romper el guardado
            log.exception("No se pudo crear la versión automática de %s", board_id)
            return
        self._last_auto[board_id] = now

    async def flush_all(self) -> None:
        """Al apagar: guarda todo lo pendiente y deja el autosaver limpio."""
        self._closing = True
        try:
            tasks = list(self._tasks.values())
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            await asyncio.gather(*self._background, return_exceptions=True)
            for pending in list(self._pending.values()):
                await self.flush(pending.room)
        finally:
            self._pending.clear()
            self._tasks.clear()
            self._last_auto.clear()
            self._locks.clear()  # los candados pertenecen al event loop que se apaga
            self._closing = False


autosaver = Autosaver(manager)
