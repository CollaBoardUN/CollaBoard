"""Salas en memoria: estado de los elementos, presencia y difusión de eventos.

Una sala por tablero. Garantías:

- ORDEN: cada lote de operaciones recibe un número de secuencia (`seq`) creciente
  por sala. Se asigna y se difunde bajo un candado, así todos los clientes ven
  los lotes en el mismo orden y pueden detectar si se perdieron alguno.
- RECONEXIÓN: al conectarse (o reconectarse) el cliente recibe un `sync` con el
  estado completo y el último `seq`; no hace falta reproducir historial.
- ESTADO: vive en memoria del proceso (un solo worker de uvicorn). Para que
  sobreviva a reinicios, la Persona 4 puede enchufar su persistencia en
  `manager.on_ops` (y precargar `room.elements`).
"""

import asyncio
import logging
import uuid
import zlib
from collections import OrderedDict
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field

from fastapi import WebSocket

from ..models import Role
from .validation import (
    MAX_ELEMENTS,
    MAX_OPS_PER_MESSAGE,
    clean_element,
    clean_patch,
    valid_id,
)

log = logging.getLogger(__name__)

# Colores de cursor/avatar, asignados de forma estable por usuario.
PALETTE = [
    "#E11D48",
    "#2563EB",
    "#16A34A",
    "#D97706",
    "#7C3AED",
    "#0891B2",
    "#DB2777",
    "#65A30D",
]

# Salas vacías que se conservan en memoria (para no perder el dibujo al recargar).
MAX_IDLE_ROOMS = 100


def color_for(user_id: str) -> str:
    return PALETTE[zlib.crc32(user_id.encode()) % len(PALETTE)]


@dataclass(eq=False)
class Connection:
    """Un WebSocket abierto. Un mismo usuario puede tener varias (varias pestañas)."""

    ws: WebSocket
    user_id: str
    name: str
    role: Role
    id: str = field(default_factory=lambda: uuid.uuid4().hex[:12])

    @property
    def color(self) -> str:
        return color_for(self.user_id)

    def info(self) -> dict:
        return {
            "conn": self.id,
            "user_id": self.user_id,
            "name": self.name,
            "color": self.color,
            "role": self.role.value,
        }

    async def send(self, message: dict) -> None:
        try:
            await self.ws.send_json(message)
        except Exception:  # socket roto: el bucle de lectura lo cerrará
            log.debug("No se pudo enviar a %s", self.id, exc_info=True)


# Gancho para persistencia: recibe (board_id, seq, ops ya validadas).
OpsListener = Callable[[str, int, list[dict]], Awaitable[None]]

# Gancho de carga: dado un board_id devuelve (elementos guardados, seq guardado).
StateLoader = Callable[[str], Awaitable[tuple[list[dict], int]]]


class Room:
    def __init__(self, board_id: str, on_ops: OpsListener | None = None) -> None:
        self.board_id = board_id
        self.elements: dict[str, dict] = {}  # el orden de inserción es el z-order
        self.seq = 0
        self.connections: dict[str, Connection] = {}
        self.lock = asyncio.Lock()
        self.on_ops = on_ops
        # False hasta que se cargue el estado guardado (ver RoomManager.ensure_loaded).
        self.loaded = False

    # ------------------------------------------------------------ presencia

    def presence(self) -> list[dict]:
        return [c.info() for c in self.connections.values()]

    async def broadcast(self, message: dict, exclude: Connection | None = None) -> None:
        targets = [c for c in self.connections.values() if c is not exclude]
        await asyncio.gather(*(c.send(message) for c in targets))

    async def join(self, conn: Connection) -> None:
        async with self.lock:
            self.connections[conn.id] = conn
            await conn.send(self.sync_message(conn))
            await self.broadcast({"type": "presence", "peers": self.presence()}, exclude=conn)

    async def leave(self, conn: Connection) -> None:
        async with self.lock:
            if self.connections.pop(conn.id, None) is None:
                return
            await self.broadcast({"type": "presence", "peers": self.presence()})

    async def resync(self, conn: Connection) -> None:
        async with self.lock:
            await conn.send(self.sync_message(conn))

    async def set_role(self, conn: Connection, role: Role) -> None:
        """Actualiza el rol cacheado y avisa a los demás si cambió."""
        if conn.role == role:
            return
        async with self.lock:
            conn.role = role
            await self.broadcast({"type": "presence", "peers": self.presence()})

    def sync_message(self, conn: Connection) -> dict:
        return {
            "type": "sync",
            "seq": self.seq,
            "you": conn.info(),
            "elements": list(self.elements.values()),
            "peers": self.presence(),
        }

    # ------------------------------------------------------------ operaciones

    def _apply(self, raw_ops: list, author_id: str) -> list[dict]:
        """Valida y aplica las operaciones; devuelve solo las que son válidas."""
        applied: list[dict] = []
        for raw in raw_ops[:MAX_OPS_PER_MESSAGE]:
            if not isinstance(raw, dict):
                continue
            kind = raw.get("op")
            if kind == "add":
                element = clean_element(raw.get("element"), author_id)
                if element is None:
                    continue
                if element["id"] not in self.elements and len(self.elements) >= MAX_ELEMENTS:
                    continue
                # `add` es idempotente: si ya existe se reemplaza conservando su posición.
                self.elements[element["id"]] = element
                applied.append({"op": "add", "element": element})
            elif kind == "update":
                eid, patch = raw.get("id"), clean_patch(raw.get("patch"))
                if not valid_id(eid) or patch is None or eid not in self.elements:
                    continue
                current = self.elements[eid]
                for name, value in patch.items():
                    if value is None:
                        current.pop(name, None)
                    else:
                        current[name] = value
                applied.append({"op": "update", "id": eid, "patch": patch})
            elif kind == "delete":
                eid = raw.get("id")
                if not valid_id(eid) or self.elements.pop(eid, None) is None:
                    continue
                applied.append({"op": "delete", "id": eid})
        return applied

    async def apply_ops(self, conn: Connection, raw_ops: list) -> int | None:
        """Aplica un lote y lo difunde a TODOS (incluido el autor) con su `seq`.

        El autor también lo recibe para que el orden final lo dicte el servidor.
        """
        async with self.lock:
            ops = self._apply(raw_ops, conn.user_id)
            if not ops:
                return None
            self.seq += 1
            await self.broadcast(
                {
                    "type": "ops",
                    "seq": self.seq,
                    "conn": conn.id,
                    "user_id": conn.user_id,
                    "ops": ops,
                }
            )
            if self.on_ops is not None:
                try:
                    await self.on_ops(self.board_id, self.seq, ops)
                except Exception:  # un fallo de persistencia no tumba la sala
                    log.exception("Falló el listener de persistencia")
            return self.seq

    # ------------------------------------------------------------ efímeros

    async def relay_cursor(self, conn: Connection, x: float, y: float) -> None:
        await self.broadcast({"type": "cursor", "conn": conn.id, "x": x, "y": y}, exclude=conn)

    async def relay_draft(self, conn: Connection, raw_element: dict | None) -> None:
        """Trazo en curso (aún no confirmado). No se guarda ni consume `seq`."""
        element = None
        if raw_element is not None:
            element = clean_element(raw_element, conn.user_id)
            if element is None:
                return
        await self.broadcast({"type": "draft", "conn": conn.id, "element": element}, exclude=conn)


class RoomManager:
    def __init__(self) -> None:
        self.rooms: dict[str, Room] = {}
        self._idle: OrderedDict[str, None] = OrderedDict()
        # Gancho de persistencia para las salas nuevas: `manager.on_ops = mi_funcion`.
        self.on_ops: OpsListener | None = None
        # Gancho de carga para las salas nuevas: `manager.loader = mi_funcion`.
        self.loader: StateLoader | None = None

    async def ensure_loaded(self, room: Room) -> None:
        """Llena la sala con el estado guardado, una sola vez.

        Si el loader falla, la excepción sube y la sala NO queda marcada como
        cargada: así nunca se deja que alguien edite sobre un tablero "vacío"
        que en realidad tiene contenido guardado (y que el autosave lo pisaría).
        """
        async with room.lock:
            if room.loaded:
                return
            if self.loader is not None:
                elements, seq = await self.loader(room.board_id)
                room.elements = {e["id"]: e for e in elements}
                room.seq = seq
            room.loaded = True

    def get(self, board_id: str) -> Room:
        self._idle.pop(board_id, None)
        room = self.rooms.get(board_id)
        if room is None:
            room = self.rooms[board_id] = Room(board_id, self.on_ops)
        return room

    def release(self, room: Room) -> None:
        """Llamar al salir alguien: las salas vacías se conservan hasta MAX_IDLE_ROOMS."""
        if room.connections:
            return
        self._idle[room.board_id] = None
        self._idle.move_to_end(room.board_id)
        while len(self._idle) > MAX_IDLE_ROOMS:
            oldest, _ = self._idle.popitem(last=False)
            stale = self.rooms.get(oldest)
            if stale is not None and not stale.connections:
                del self.rooms[oldest]


manager = RoomManager()
