"""WebSocket por tablero:  /ws/boards/{board_id}?token=<JWT>

Protocolo (JSON):

Cliente -> servidor
  {"type": "ops", "ref": 1, "ops": [...]}    crear / mover / borrar (solo editor u owner)
  {"type": "cursor", "x": 1, "y": 2}         posición del cursor (todos los roles)
  {"type": "draft", "element": {...}|null}   trazo en curso (solo editor u owner)
  {"type": "resync"}                         pide el estado completo otra vez
  {"type": "ping"}

Servidor -> cliente
  {"type": "sync", "seq", "you", "elements", "peers"}
  {"type": "ops", "seq", "conn", "user_id", "ops"}
  {"type": "ack", "ref", "seq"}               el lote `ref` ya lo procesó el servidor
  {"type": "presence", "peers": [...]}
  {"type": "cursor", "conn", "x", "y"}
  {"type": "draft", "conn", "element"}
  {"type": "error", "code", "message"}
  {"type": "pong"}
  {"type": "saved", "seq", "saved_at"}       el autosave guardó el tablero hasta ese `seq`
  {"type": "save_error", "message"}          no se pudo guardar; el servidor reintenta solo
  {"type": "restored", "version", "by"}      alguien restauró una versión; justo después
                                             llega un `sync` con el tablero completo

Códigos de cierre: 4401 token inválido, 4403 sin acceso al tablero.
"""

import json
import logging
import time

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect

from ..auth import decode_token
from ..database import SessionLocal
from ..models import Role
from ..permissions import can, get_role, get_role_remote
from ..persistence.autosave import autosaver
from ..realtime.rooms import Connection, manager
from ..realtime.validation import clean_cursor

router = APIRouter()
log = logging.getLogger(__name__)

CLOSE_UNAUTHORIZED = 4401
CLOSE_FORBIDDEN = 4403
CLOSE_SERVER_ERROR = 1011
MAX_MESSAGE_BYTES = 2_000_000
# Cada cuánto se vuelve a comprobar el rol en mensajes que no son de dibujo.
ROLE_RECHECK_SECONDS = 5.0


async def _role_of(board_id: str, user_id: str) -> Role | None:
    role = await get_role_remote(board_id, user_id)
    if role is None:
        with SessionLocal() as db:
            role = get_role(db, board_id, user_id)
    return role


async def _error(conn: Connection, code: str, message: str) -> None:
    await conn.send({"type": "error", "code": code, "message": message})


@router.websocket("/ws/boards/{board_id}")
async def board_ws(websocket: WebSocket, board_id: str, token: str = "") -> None:
    # Aceptamos primero para poder cerrar con un código propio (4401/4403): si se
    # cierra antes de aceptar, el navegador solo ve un error genérico y no sabría
    # que no debe reintentar.
    await websocket.accept()

    try:
        user = decode_token(token)
    except HTTPException:
        await websocket.close(code=CLOSE_UNAUTHORIZED, reason="Token inválido")
        return

    role = await _role_of(board_id, user.id)
    if role is None:
        await websocket.close(code=CLOSE_FORBIDDEN, reason="No eres miembro del tablero")
        return

    room = manager.get(board_id)
    try:
        # Persistencia: la primera conexión carga lo guardado en la base de datos.
        await manager.ensure_loaded(room)
    except Exception:
        log.exception("No se pudo cargar el estado del tablero %s", board_id)
        manager.release(room)
        await websocket.close(code=CLOSE_SERVER_ERROR, reason="No se pudo cargar el tablero")
        return

    conn = Connection(ws=websocket, user_id=user.id, name=user.display_name or user.id, role=role)
    await room.join(conn)

    last_check = time.monotonic()
    try:
        while True:
            text = await websocket.receive_text()
            if len(text) > MAX_MESSAGE_BYTES:
                await _error(conn, "too_large", "Mensaje muy grande")
                continue
            try:
                message = json.loads(text)
            except ValueError:
                message = None
            if not isinstance(message, dict):
                await _error(conn, "bad_message", "JSON inválido")
                continue
            kind = message.get("type")

            # Re-verificamos el rol: siempre antes de ops, y cada pocos segundos en el resto.
            # Así, si el owner quita o degrada a alguien, el cambio se aplica enseguida.
            now = time.monotonic()
            if kind == "ops" or now - last_check > ROLE_RECHECK_SECONDS:
                current = await _role_of(board_id, user.id)
                last_check = now
                if current is None:
                    await websocket.close(code=CLOSE_FORBIDDEN, reason="Ya no eres miembro")
                    return
                await room.set_role(conn, current)

            if kind == "ops":
                if not can(conn.role, Role.editor):
                    await _error(conn, "forbidden", "Solo puedes mirar este tablero")
                    continue
                ops = message.get("ops")
                if isinstance(ops, list):
                    seq = await room.apply_ops(conn, ops)
                    # Confirma el lote (aunque no se aplicara nada) para que el cliente
                    # sepa que no debe reenviarlo al reconectar.
                    await conn.send({"type": "ack", "ref": message.get("ref"), "seq": seq})
            elif kind == "cursor":
                point = clean_cursor(message.get("x"), message.get("y"))
                if point:
                    await room.relay_cursor(conn, *point)
            elif kind == "draft":
                if can(conn.role, Role.editor):
                    element = message.get("element")
                    if element is None or isinstance(element, dict):
                        await room.relay_draft(conn, element)
            elif kind == "resync":
                await room.resync(conn)
            elif kind == "ping":
                await conn.send({"type": "pong"})
    except WebSocketDisconnect:
        pass
    finally:
        try:
            await room.leave(conn)
            if not room.connections:
                # Última persona fuera: guardado final (con versión), sin esperar al
                # debounce. Es a prueba de cancelación: ver `Autosaver.flush_final`.
                await autosaver.flush_final(room)
        finally:
            manager.release(room)
