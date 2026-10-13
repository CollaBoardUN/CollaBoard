"""Tests del autosave: debounce, tope de espera, reintentos y guardado al salir."""

import asyncio
import time
from types import SimpleNamespace

import pytest

from app.database import SessionLocal
from app.persistence.autosave import Autosaver, save_in_thread
from app.persistence.store import list_versions, load_state
from app.realtime.rooms import Room, manager

from .test_persistence import clean_rooms, rect, ws_url  # noqa: F401


class FakeConn:
    """Una conexión que solo guarda lo que le mandan."""

    def __init__(self) -> None:
        self.id = "fake"
        self.messages: list[dict] = []

    async def send(self, message: dict) -> None:
        self.messages.append(message)


def make_room(board_id: str, *ids: str) -> tuple[Room, FakeConn]:
    room = Room(board_id)
    room.loaded = True
    room.elements = {i: rect(i) for i in ids}
    room.seq = 1
    conn = FakeConn()
    room.connections[conn.id] = conn  # type: ignore[assignment]
    return room, conn


def make_saver(room: Room, **kwargs) -> tuple[Autosaver, list[int]]:
    calls: list[int] = []
    fail_first = kwargs.pop("fail_first", 0)

    def save(board_id, elements, seq):
        calls.append(seq)
        if len(calls) <= fail_first:
            raise RuntimeError("base de datos caída")
        return save_in_thread(board_id, elements, seq)

    manager_stub = SimpleNamespace(rooms={room.board_id: room})
    saver = Autosaver(manager_stub, save_fn=save, **kwargs)
    return saver, calls


def stored(board_id: str) -> list[str]:
    with SessionLocal() as db:
        return [e["id"] for e in load_state(db, board_id)[0]]


def wait_for(condition, timeout: float = 3.0) -> bool:
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if condition():
            return True
        time.sleep(0.02)
    return condition()


# ------------------------------------------------------------------ unitarios


def test_varias_operaciones_seguidas_se_guardan_una_sola_vez(board):
    room, conn = make_room(board["id"], "a", "b")
    saver, calls = make_saver(room, debounce=0.1, max_wait=5)

    async def scenario():
        for seq in range(1, 6):
            await saver.on_ops(board["id"], seq, [])
        assert calls == []  # todavía no: el debounce no ha vencido
        await asyncio.sleep(0.4)

    asyncio.run(scenario())
    assert len(calls) == 1
    assert stored(board["id"]) == ["a", "b"]
    assert [m["type"] for m in conn.messages] == ["saved"]
    assert conn.messages[0]["seq"] == 1


def test_dibujar_sin_parar_no_aplaza_el_guardado_para_siempre(board):
    room, _ = make_room(board["id"], "a")
    saver, calls = make_saver(room, debounce=0.2, max_wait=0.3)

    async def scenario():
        for seq in range(1, 15):  # una operación cada 50 ms durante 0,7 s
            await saver.on_ops(board["id"], seq, [])
            await asyncio.sleep(0.05)
            if seq == 9:
                assert len(calls) >= 1  # el tope de espera ya forzó un guardado
        await asyncio.sleep(0.4)

    asyncio.run(scenario())
    assert stored(board["id"]) == ["a"]


def test_si_falla_avisa_y_reintenta_hasta_guardar(board):
    room, conn = make_room(board["id"], "a")
    saver, calls = make_saver(room, debounce=0.05, max_wait=1, retry=0.1, fail_first=1)

    async def scenario():
        await saver.on_ops(board["id"], 1, [])
        await asyncio.sleep(0.6)

    asyncio.run(scenario())
    assert len(calls) == 2
    assert [m["type"] for m in conn.messages] == ["save_error", "saved"]
    assert stored(board["id"]) == ["a"]


def test_tablero_borrado_no_se_reintenta(board):
    room, conn = make_room("tablero-que-no-existe", "a")
    saver, calls = make_saver(room, debounce=0.05, retry=0.05)

    async def scenario():
        await saver.on_ops("tablero-que-no-existe", 1, [])
        await asyncio.sleep(0.4)

    asyncio.run(scenario())
    assert len(calls) == 1
    assert conn.messages == []
    assert saver._pending == {}


def test_flush_all_guarda_lo_pendiente_al_apagar(board):
    room, _ = make_room(board["id"], "a", "b", "c")
    saver, calls = make_saver(room, debounce=30, max_wait=60)  # no vencería nunca

    async def scenario():
        await saver.on_ops(board["id"], 1, [])
        assert calls == []
        await saver.flush_all()

    asyncio.run(scenario())
    assert len(calls) == 1
    assert stored(board["id"]) == ["a", "b", "c"]
    assert saver._tasks == {} and saver._pending == {}


def test_sin_cambios_no_guarda_de_nuevo(board):
    room, _ = make_room(board["id"], "a")
    saver, calls = make_saver(room, debounce=0.05)

    async def scenario():
        await saver.flush(room)  # nada pendiente
        await saver.on_ops(board["id"], 1, [])
        await asyncio.sleep(0.3)
        await saver.flush(room)  # ya guardado

    asyncio.run(scenario())
    assert len(calls) == 1


def test_el_guardado_final_termina_aunque_cancelen_a_quien_lo_espera(board):
    """El manejador del WebSocket puede ser cancelado al desconectarse el cliente (el
    `TestClient` de Starlette lo hace): ni el estado ni la versión deben perderse."""
    room, _ = make_room(board["id"], "a")
    saver, _ = make_saver(room, debounce=30, max_wait=60)

    async def scenario():
        await saver.on_ops(board["id"], 1, [])
        waiter = asyncio.create_task(saver.flush_final(room))
        await asyncio.sleep(0)  # deja que arranque el guardado
        waiter.cancel()
        with pytest.raises(asyncio.CancelledError):
            await waiter
        await saver.flush_all()  # espera a que el guardado en segundo plano termine

    asyncio.run(scenario())
    assert stored(board["id"]) == ["a"]
    with SessionLocal() as db:
        assert [v.kind for v in list_versions(db, board["id"])] == ["auto"]


# ------------------------------------------------------------------ integración


@pytest.fixture
def fast_autosave(monkeypatch):
    from app.persistence.autosave import autosaver

    monkeypatch.setattr(autosaver, "debounce", 0.05)
    monkeypatch.setattr(autosaver, "max_wait", 1.0)
    return autosaver


def test_dibujar_se_guarda_y_la_sala_recibe_saved(client, board, fast_autosave):
    with client.websocket_connect(ws_url(board["id"])) as ws:
        ws.receive_json()  # sync
        ws.send_json({"type": "ops", "ref": 1, "ops": [{"op": "add", "element": rect("x")}]})
        saved = None
        while saved is None:
            message = ws.receive_json()
            if message["type"] == "saved":
                saved = message
    assert saved["seq"] == 1
    assert wait_for(lambda: stored(board["id"]) == ["x"])


def test_al_salir_la_ultima_persona_se_guarda_sin_esperar(client, board, monkeypatch):
    from app.persistence.autosave import autosaver

    monkeypatch.setattr(autosaver, "debounce", 60)  # el timer nunca llegaría a tiempo
    monkeypatch.setattr(autosaver, "max_wait", 120)
    with client.websocket_connect(ws_url(board["id"])) as ws:
        ws.receive_json()
        ws.send_json({"type": "ops", "ref": 1, "ops": [{"op": "add", "element": rect("y")}]})
        while ws.receive_json()["type"] != "ack":
            pass
    assert wait_for(lambda: stored(board["id"]) == ["y"])


def test_cerrar_reiniciar_y_reabrir_sin_guardar_a_mano(client, board, fast_autosave):
    """El entregable: dibujar, cerrar, 'reiniciar' el servidor y encontrar todo."""
    with client.websocket_connect(ws_url(board["id"])) as ws:
        ws.receive_json()
        ops = [{"op": "add", "element": rect(i)} for i in ("a", "b", "c")]
        ws.send_json({"type": "ops", "ref": 1, "ops": ops})
        while ws.receive_json()["type"] != "ack":
            pass
    assert wait_for(lambda: stored(board["id"]) == ["a", "b", "c"])

    manager.rooms.clear()  # reinicio: la memoria se pierde

    with client.websocket_connect(ws_url(board["id"])) as ws:
        sync = ws.receive_json()
    assert [e["id"] for e in sync["elements"]] == ["a", "b", "c"]
    assert sync["seq"] == 1
