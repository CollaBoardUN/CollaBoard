"""Despachador de outbox transaccional de Colaboración.

Colaboración persiste sus efectos secundarios externos en la tabla `outbox_events`
dentro de la MISMA transacción SQL que el cambio de negocio:
  1. `notification.event` -> `POST {NOTIFICATIONS_URL}/internal/events`
     (p. ej. `invite.accepted` dirigido al propietario del tablero).
  2. `cleanup.canvas` -> `DELETE {PIZARRA_INTERNAL_URL}/internal/canvas/boards/{id}`
  3. `cleanup.chat`   -> `DELETE {CHAT_INTERNAL_URL}/internal/chat/boards/{id}`

Reglas de confiabilidad (plan P2, secciones 4 y 6):
  - El mismo `event_id` se conserva en todos los reintentos.
  - Una caída de NotificationAPI, Pizarra o Chat NO revierte la operación de negocio.
  - Cuando terminan las tareas de limpieza de un tablero en estado `deleting`, el
    tablero pasa a `deleted` (no se reconoce el borrado físico total antes de completar
    la limpieza remota).
"""

import asyncio
import contextlib
import logging
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
from sqlalchemy import select
from sqlalchemy.orm import Session

from .config import (
    CHAT_INTERNAL_URL,
    INTERNAL_SERVICE_TOKEN,
    NOTIFICATIONS_URL,
    OUTBOX_ENABLED,
    OUTBOX_HTTP_TIMEOUT_SECONDS,
    OUTBOX_MAX_ATTEMPTS,
    OUTBOX_POLL_SECONDS,
    PIZARRA_INTERNAL_URL,
)
from .database import SessionLocal
from .models import Board, BoardStatus, OutboxEvent, OutboxStatus, Role, utcnow

log = logging.getLogger("collaboard.colaboracion.outbox")

KIND_NOTIFICATION = "notification.event"
KIND_CLEANUP_CANVAS = "cleanup.canvas"
KIND_CLEANUP_CHAT = "cleanup.chat"


def enqueue_invite_accepted(
    db: Session,
    *,
    board: Board,
    actor_id: str,
    actor_name: str | None,
    role: Role,
) -> OutboxEvent | None:
    """Agrega en la sesión actual el evento `invite.accepted` dirigido al propietario.

    No emite evento si quien acepta es el mismo propietario del tablero.
    """
    if actor_id == board.owner_id:
        return None

    now = utcnow()
    event_id = f"evt-invite-{uuid.uuid4()}"
    event_payload: dict[str, Any] = {
        "event_id": event_id,
        "type": "invite.accepted",
        "occurred_at": now.isoformat().replace("+00:00", "Z"),
        "actor_id": actor_id,
        "board_id": board.id,
        "recipient_ids": [board.owner_id],
        "payload": {
            "board_name": board.name,
            "actor_name": actor_name or actor_id,
            "role": role.value if isinstance(role, Role) else str(role),
        },
    }
    entry = OutboxEvent(
        event_id=event_id,
        kind=KIND_NOTIFICATION,
        board_id=board.id,
        method="POST",
        target_url=f"{NOTIFICATIONS_URL}/internal/events",
        payload=event_payload,
        status=OutboxStatus.pending.value,
        attempts=0,
        next_attempt_at=now,
    )
    db.add(entry)
    return entry


def enqueue_board_cleanup(db: Session, board: Board) -> list[OutboxEvent]:
    """Encola las solicitudes HTTP idempotentes de limpieza de Canvas y Chat."""
    now = utcnow()
    canvas_event = OutboxEvent(
        event_id=f"cleanup-canvas-{board.id}",
        kind=KIND_CLEANUP_CANVAS,
        board_id=board.id,
        method="DELETE",
        target_url=f"{PIZARRA_INTERNAL_URL}/internal/canvas/boards/{board.id}",
        payload=None,
        status=OutboxStatus.pending.value,
        attempts=0,
        next_attempt_at=now,
    )
    chat_event = OutboxEvent(
        event_id=f"cleanup-chat-{board.id}",
        kind=KIND_CLEANUP_CHAT,
        board_id=board.id,
        method="DELETE",
        target_url=f"{CHAT_INTERNAL_URL}/internal/chat/boards/{board.id}",
        payload=None,
        status=OutboxStatus.pending.value,
        attempts=0,
        next_attempt_at=now,
    )
    db.add_all([canvas_event, chat_event])
    return [canvas_event, chat_event]


def _backoff_seconds(attempts: int) -> float:
    return float(min(60, 2 ** min(attempts, 6)))


def _is_delivered(kind: str, status_code: int) -> bool:
    if kind == KIND_NOTIFICATION:
        # 200/201/202 aceptado; 409 duplicado ya registrado por NotificationAPI
        return status_code in (200, 201, 202, 204, 409)
    # Limpieza idempotente: 200/202/204 o 404 (ya no existía en el servicio remoto)
    return status_code in (200, 202, 204, 404)


def _refresh_board_deletion_state(db: Session, board_id: str) -> None:
    """Marca el tablero como 'deleted' solo cuando Canvas y Chat completaron su limpieza."""
    board = db.get(Board, board_id)
    if board is None or board.status != BoardStatus.deleting.value:
        return

    cleanup_rows = list(
        db.scalars(
            select(OutboxEvent).where(
                OutboxEvent.board_id == board_id,
                OutboxEvent.kind.in_([KIND_CLEANUP_CANVAS, KIND_CLEANUP_CHAT]),
            )
        ).all()
    )
    if cleanup_rows and all(r.status == OutboxStatus.sent.value for r in cleanup_rows):
        board.status = BoardStatus.deleted.value
        board.updated_at = utcnow()


async def dispatch_pending_once(
    http_client: httpx.AsyncClient | None = None,
    *,
    limit: int = 50,
    ignore_schedule: bool = False,
) -> int:
    """Procesa un lote de eventos pendientes del outbox. Devuelve cuántos quedaron 'sent'."""
    now = datetime.now(UTC)
    own_client = http_client is None
    client = http_client or httpx.AsyncClient(timeout=OUTBOX_HTTP_TIMEOUT_SECONDS)
    delivered_count = 0

    try:
        with SessionLocal() as db:
            stmt = select(OutboxEvent).where(OutboxEvent.status == OutboxStatus.pending.value)
            if not ignore_schedule:
                stmt = stmt.where(OutboxEvent.next_attempt_at <= now)
            pending = list(
                db.scalars(stmt.order_by(OutboxEvent.created_at).limit(limit)).all()
            )

            for item in pending:
                headers = {
                    "X-Service-Token": INTERNAL_SERVICE_TOKEN,
                    "X-Event-Id": item.event_id,
                    "Accept": "application/json",
                }
                try:
                    if item.method.upper() == "DELETE":
                        resp = await client.delete(item.target_url, headers=headers)
                    else:
                        headers["Content-Type"] = "application/json"
                        resp = await client.request(
                            item.method.upper(),
                            item.target_url,
                            json=item.payload,
                            headers=headers,
                        )

                    if _is_delivered(item.kind, resp.status_code):
                        item.status = OutboxStatus.sent.value
                        item.sent_at = utcnow()
                        item.attempts += 1
                        item.last_error = None
                        delivered_count += 1
                        if item.kind in (KIND_CLEANUP_CANVAS, KIND_CLEANUP_CHAT):
                            _refresh_board_deletion_state(db, item.board_id)
                    else:
                        item.attempts += 1
                        item.last_error = f"HTTP {resp.status_code}"
                        if item.attempts >= OUTBOX_MAX_ATTEMPTS:
                            item.status = OutboxStatus.failed.value
                        else:
                            item.next_attempt_at = utcnow() + timedelta(
                                seconds=_backoff_seconds(item.attempts)
                            )
                        log.warning(
                            "Outbox %s (%s) recibió HTTP %s en intento %s",
                            item.event_id,
                            item.kind,
                            resp.status_code,
                            item.attempts,
                        )
                except Exception as exc:
                    item.attempts += 1
                    item.last_error = exc.__class__.__name__
                    if item.attempts >= OUTBOX_MAX_ATTEMPTS:
                        item.status = OutboxStatus.failed.value
                    else:
                        item.next_attempt_at = utcnow() + timedelta(
                            seconds=_backoff_seconds(item.attempts)
                        )
                    log.warning(
                        "Outbox %s (%s) pendiente para reintento (%s)",
                        item.event_id,
                        item.kind,
                        exc.__class__.__name__,
                    )

            db.commit()
    finally:
        if own_client:
            await client.aclose()

    return delivered_count


class OutboxWorker:
    """Tarea en segundo plano que despacha periódicamente el outbox."""

    def __init__(self) -> None:
        self._task: asyncio.Task[None] | None = None
        self._stop = asyncio.Event()

    async def start(self) -> None:
        if not OUTBOX_ENABLED or self._task is not None:
            return
        self._stop.clear()
        self._task = asyncio.create_task(self._run_loop())

    async def stop(self) -> None:
        if self._task is None:
            return
        self._stop.set()
        self._task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await self._task
        self._task = None

    async def _run_loop(self) -> None:
        async with httpx.AsyncClient(timeout=OUTBOX_HTTP_TIMEOUT_SECONDS) as client:
            while not self._stop.is_set():
                try:
                    await dispatch_pending_once(client)
                except Exception as exc:
                    log.warning("Ciclo de outbox falló: %s", exc.__class__.__name__)
                with contextlib.suppress(TimeoutError):
                    await asyncio.wait_for(self._stop.wait(), timeout=OUTBOX_POLL_SECONDS)


outbox_worker = OutboxWorker()
