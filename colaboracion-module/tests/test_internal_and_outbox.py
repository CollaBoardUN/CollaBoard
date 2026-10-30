"""Pruebas de los contratos internos (/internal/*), outbox transaccional y borrado coordinado."""

import asyncio
import os

import httpx
from sqlalchemy import select

from app.database import SessionLocal
from app.models import Board, BoardStatus, OutboxEvent, OutboxStatus
from app.outbox import (
    KIND_CLEANUP_CANVAS,
    KIND_CLEANUP_CHAT,
    KIND_NOTIFICATION,
    dispatch_pending_once,
)

from .conftest import invite, join, service_headers, token_for

# ---------------------------------------------------------------- /internal/boards/{id}/access


def test_internal_access_roles_owner_editor_viewer(client, ana, beto, caro, board):
    join(client, beto, invite(client, ana, board["id"], "editor")["token"])
    join(client, caro, invite(client, ana, board["id"], "viewer")["token"])

    r_owner = client.get(
        f"/internal/boards/{board['id']}/access",
        headers=service_headers("ana", "Ana"),
    )
    assert r_owner.status_code == 200
    assert r_owner.json() == {
        "board_id": board["id"],
        "board_name": "Tablero de Ana",
        "owner_id": "ana",
        "user_id": "ana",
        "role": "owner",
        "exists": True,
        "board_status": "active",
    }

    r_editor = client.get(
        f"/internal/boards/{board['id']}/access",
        headers=service_headers("beto", "Beto"),
    )
    assert r_editor.status_code == 200
    assert r_editor.json()["role"] == "editor"

    r_viewer = client.get(
        f"/internal/boards/{board['id']}/access",
        headers=service_headers("caro", "Caro"),
    )
    assert r_viewer.status_code == 200
    assert r_viewer.json()["role"] == "viewer"


def test_internal_access_no_permite_sustituir_user_id_del_jwt(client, ana, beto, board):
    """El llamador NO puede sustituir libremente user_id si envía el JWT de otro usuario."""
    headers = service_headers("beto", "Beto")
    headers["X-User-Id"] = "ana"
    r = client.get(
        f"/internal/boards/{board['id']}/access?user_id=ana",
        headers=headers,
    )
    # Beto no es miembro -> 404 aunque mande X-User-Id=ana y ?user_id=ana
    assert r.status_code == 404


def test_internal_access_retiro_de_miembro_corta_acceso(client, ana, beto, board):
    join(client, beto, invite(client, ana, board["id"], "editor")["token"])
    assert (
        client.get(
            f"/internal/boards/{board['id']}/access",
            headers=service_headers("beto", "Beto"),
        ).status_code
        == 200
    )

    # El propietario expulsa a Beto
    assert client.delete(f"/boards/{board['id']}/members/beto", headers=ana).status_code == 204

    # Inmediatamente el endpoint interno niega el acceso (para Pizarra y Chat)
    assert (
        client.get(
            f"/internal/boards/{board['id']}/access",
            headers=service_headers("beto", "Beto"),
        ).status_code
        == 404
    )


def test_internal_access_rechaza_credencial_de_servicio_invalida(client, ana, board):
    r = client.get(
        f"/internal/boards/{board['id']}/access",
        headers={
            "X-Service-Token": "token-falso",
            "Authorization": f"Bearer {token_for('ana')}",
        },
    )
    assert r.status_code == 401


def test_internal_access_sin_credenciales_da_401(client, board):
    r = client.get(f"/internal/boards/{board['id']}/access?user_id=ana")
    assert r.status_code == 401


# ---------------------------------------------------------------- /internal/boards/{id}/recipients


def test_internal_recipients_excluye_al_actor_y_ajenos(client, ana, beto, caro, board):
    join(client, beto, invite(client, ana, board["id"], "editor")["token"])
    join(client, caro, invite(client, ana, board["id"], "viewer")["token"])

    r = client.get(
        f"/internal/boards/{board['id']}/recipients",
        headers=service_headers("beto", "Beto"),
    )
    assert r.status_code == 200
    data = r.json()
    assert data["board_id"] == board["id"]
    assert data["board_name"] == "Tablero de Ana"
    assert data["owner_id"] == "ana"
    assert data["recipient_ids"] == ["ana", "caro"]

    # Un tercero ajeno no puede consultar destinatarios del tablero
    r_outsider = client.get(
        f"/internal/boards/{board['id']}/recipients",
        headers=service_headers("intruso", "Intruso"),
    )
    assert r_outsider.status_code == 404


# ---------------------------------------------------------------- /internal/boards/{id}/metadata


def test_internal_metadata_actualiza_last_saved_at_y_no_resucita_borrado(client, ana, board):
    saved_iso = "2026-10-30T20:00:00Z"
    r = client.patch(
        f"/internal/boards/{board['id']}/metadata",
        json={"element_count": 12, "seq": 34, "state_hash": "abc123", "saved_at": saved_iso},
        headers={"X-Service-Token": os.environ["INTERNAL_SERVICE_TOKEN"]},
    )
    assert r.status_code == 204

    with SessionLocal() as db:
        b = db.get(Board, board["id"])
        assert b is not None
        assert b.last_saved_at is not None

    # Si el tablero se borra, un autosave tardío recibe 404 y no lo reactiva
    client.delete(f"/boards/{board['id']}", headers=ana)
    r_late = client.patch(
        f"/internal/boards/{board['id']}/metadata",
        json={"element_count": 99, "seq": 99, "state_hash": "late", "saved_at": saved_iso},
        headers={"X-Service-Token": os.environ["INTERNAL_SERVICE_TOKEN"]},
    )
    assert r_late.status_code == 404
    with SessionLocal() as db:
        b = db.get(Board, board["id"])
        assert b.status != BoardStatus.active.value


# ---------------------------------------------------------------- Outbox: invite.accepted


def test_aceptar_invitacion_persiste_evento_hacia_owner_y_reintenta_con_mismo_event_id(
    client, ana, beto, board
):
    inv = invite(client, ana, board["id"], "editor")
    join(client, beto, inv["token"])

    # Reaceptar con el mismo rol no duplica el evento
    join(client, beto, inv["token"])

    with SessionLocal() as db:
        events = list(
            db.scalars(
                select(OutboxEvent).where(
                    OutboxEvent.board_id == board["id"],
                    OutboxEvent.kind == KIND_NOTIFICATION,
                )
            ).all()
        )
        assert len(events) == 1
        ev = events[0]
        original_event_id = ev.event_id
        assert ev.status == OutboxStatus.pending.value
        assert ev.payload["type"] == "invite.accepted"
        assert ev.payload["actor_id"] == "beto"
        assert ev.payload["recipient_ids"] == ["ana"]
        assert ev.payload["payload"] == {
            "board_name": "Tablero de Ana",
            "actor_name": "Beto",
            "role": "editor",
        }

    # Simular caída de NotificationAPI (503) seguida de recuperación (202):
    # la invitación ya quedó aceptada y el reintento conserva exactamente el mismo event_id.
    received_bodies: list[dict] = []
    call_count = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal call_count
        call_count += 1
        assert request.headers["X-Service-Token"] == os.environ["INTERNAL_SERVICE_TOKEN"]
        import json

        body = json.loads(request.content.decode("utf-8"))
        received_bodies.append(body)
        if call_count == 1:
            return httpx.Response(503, json={"detail": "NotificationAPI caída"})
        return httpx.Response(202, json={"accepted": True})

    async def run_dispatch():
        transport = httpx.MockTransport(handler)
        async with httpx.AsyncClient(transport=transport) as mock_http:
            sent_1 = await dispatch_pending_once(mock_http, ignore_schedule=True)
            assert sent_1 == 0
            sent_2 = await dispatch_pending_once(mock_http, ignore_schedule=True)
            assert sent_2 == 1

    asyncio.run(run_dispatch())

    assert len(received_bodies) == 2
    assert received_bodies[0]["event_id"] == original_event_id
    assert received_bodies[1]["event_id"] == original_event_id

    with SessionLocal() as db:
        ev = db.scalar(select(OutboxEvent).where(OutboxEvent.event_id == original_event_id))
        assert ev.status == OutboxStatus.sent.value
        assert ev.attempts == 2
        assert ev.sent_at is not None


# ---------------------------------------------------------------- Borrado coordinado


def test_borrado_coordinado_desactiva_bloquea_y_limpia_canvas_y_chat(client, ana, beto, board):
    inv = invite(client, ana, board["id"], "editor")
    join(client, beto, inv["token"])

    r = client.delete(f"/boards/{board['id']}", headers=ana)
    assert r.status_code == 204

    # 1. Bloqueo inmediato en rutas públicas e internas
    assert client.get(f"/boards/{board['id']}", headers=ana).status_code == 404
    assert (
        client.get(
            f"/internal/boards/{board['id']}/access",
            headers=service_headers("ana", "Ana"),
        ).status_code
        == 404
    )
    assert client.post(f"/invites/{inv['token']}/accept", headers=beto).status_code == 404

    # 2. Mientras las limpiezas remotas no se confirman, el estado es 'deleting' (no 'deleted')
    with SessionLocal() as db:
        b = db.get(Board, board["id"])
        assert b.status == BoardStatus.deleting.value
        cleanups = list(
            db.scalars(
                select(OutboxEvent).where(
                    OutboxEvent.board_id == board["id"],
                    OutboxEvent.kind.in_([KIND_CLEANUP_CANVAS, KIND_CLEANUP_CHAT]),
                )
            ).all()
        )
        assert len(cleanups) == 2

    # 3. Simular que Canvas responde 204 en el primer intento pero Chat falla (502) y luego 204
    called_urls: list[str] = []
    chat_attempts = 0

    def cleanup_handler(request: httpx.Request) -> httpx.Response:
        nonlocal chat_attempts
        url = str(request.url)
        called_urls.append(f"{request.method} {url}")
        if "/internal/canvas/boards/" in url:
            return httpx.Response(204)
        if "/internal/chat/boards/" in url:
            chat_attempts += 1
            if chat_attempts == 1:
                return httpx.Response(502)
            return httpx.Response(204)
        return httpx.Response(202)

    async def run_cleanup():
        transport = httpx.MockTransport(cleanup_handler)
        async with httpx.AsyncClient(transport=transport) as mock_http:
            await dispatch_pending_once(mock_http, ignore_schedule=True)
            with SessionLocal() as db:
                # Aún falta Chat -> sigue en 'deleting'
                assert db.get(Board, board["id"]).status == BoardStatus.deleting.value
            await dispatch_pending_once(mock_http, ignore_schedule=True)

    asyncio.run(run_cleanup())

    with SessionLocal() as db:
        b = db.get(Board, board["id"])
        assert b.status == BoardStatus.deleted.value
        assert b.deleted_at is not None
