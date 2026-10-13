"""Tests de persistencia: guardar, cargar al unirse y borrado en cascada."""

import pytest
from sqlalchemy import select
from starlette.websockets import WebSocketDisconnect

from app.database import SessionLocal
from app.models import Board
from app.persistence.models import BoardState
from app.persistence.store import BoardGone, content_hash, load_state, save_state
from app.realtime.rooms import manager

from .conftest import token_for


def rect(eid: str, **extra) -> dict:
    return {
        "id": eid,
        "type": "rectangle",
        "x": 1,
        "y": 2,
        "width": 30,
        "height": 40,
        "fillColor": "#fff",
        "strokeColor": "#000",
        "strokeWidth": 2,
        "authorId": "ana",
        **extra,
    }


def ws_url(board_id: str, user: str = "ana") -> str:
    return f"/ws/boards/{board_id}?token={token_for(user, user.title())}"


@pytest.fixture(autouse=True)
def clean_rooms():
    """Cada test arranca con la memoria del servidor vacía (como tras un reinicio)."""
    manager.rooms.clear()
    manager._idle.clear()
    yield
    manager.rooms.clear()
    manager._idle.clear()


def save(board_id: str, elements: list[dict], seq: int = 1) -> bool:
    with SessionLocal() as db:
        return save_state(db, board_id, elements, seq)


# ------------------------------------------------------------------ store


def test_tablero_sin_estado_carga_vacio(board):
    with SessionLocal() as db:
        assert load_state(db, board["id"]) == ([], 0)


def test_guardar_y_cargar_conserva_elementos_y_orden(board):
    elements = [rect("b"), rect("a"), rect("c")]
    assert save(board["id"], elements, seq=7) is True
    with SessionLocal() as db:
        loaded, seq = load_state(db, board["id"])
    assert [e["id"] for e in loaded] == ["b", "a", "c"]  # el z-order se conserva
    assert seq == 7


def test_guardar_lo_mismo_no_cambia_nada(board):
    save(board["id"], [rect("a")], seq=1)
    assert save(board["id"], [rect("a")], seq=1) is False
    assert save(board["id"], [rect("a", x=99)], seq=2) is True


def test_guardar_actualiza_updated_at_solo_si_hay_cambios(client, ana, board):
    before = client.get(f"/boards/{board['id']}", headers=ana).json()["updated_at"]
    save(board["id"], [rect("a")])
    after = client.get(f"/boards/{board['id']}", headers=ana).json()["updated_at"]
    assert after > before

    save(board["id"], [rect("a")])  # sin cambios
    assert client.get(f"/boards/{board['id']}", headers=ana).json()["updated_at"] == after


def test_guardar_en_un_tablero_borrado_avisa(board):
    with SessionLocal() as db, pytest.raises(BoardGone):
        save_state(db, "no-existe", [], 0)


def test_el_hash_no_depende_del_orden_de_las_llaves():
    assert content_hash([{"id": "a", "x": 1}]) == content_hash([{"x": 1, "id": "a"}])


def test_borrar_el_tablero_borra_su_estado(client, ana, board):
    save(board["id"], [rect("a")])
    assert client.delete(f"/boards/{board['id']}", headers=ana).status_code == 204
    with SessionLocal() as db:
        assert db.get(Board, board["id"]) is None
        assert db.scalar(select(BoardState).where(BoardState.board_id == board["id"])) is None


# ------------------------------------------------------------------ al unirse


def test_al_unirse_se_carga_lo_guardado(client, board):
    save(board["id"], [rect("a"), rect("b")], seq=5)
    with client.websocket_connect(ws_url(board["id"])) as ws:
        sync = ws.receive_json()
    assert sync["type"] == "sync"
    assert [e["id"] for e in sync["elements"]] == ["a", "b"]
    assert sync["seq"] == 5


def test_cerrar_y_reabrir_conserva_todo(client, board):
    """Dibuja, 'guarda', simula un reinicio del servidor y vuelve a entrar."""
    with client.websocket_connect(ws_url(board["id"])) as ws:
        ws.receive_json()  # sync inicial
        ws.send_json({"type": "ops", "ref": 1, "ops": [{"op": "add", "element": rect("x")}]})
        while ws.receive_json()["type"] != "ack":
            pass
        room = manager.rooms[board["id"]]
        save(board["id"], list(room.elements.values()), room.seq)

    manager.rooms.clear()  # el servidor se reinició: la memoria se perdió

    with client.websocket_connect(ws_url(board["id"])) as ws:
        sync = ws.receive_json()
    assert [e["id"] for e in sync["elements"]] == ["x"]
    assert sync["seq"] == 1


def test_la_carga_ocurre_una_sola_vez_por_sala(client, board):
    save(board["id"], [rect("a")])
    calls = []
    original = manager.loader

    async def spy(board_id):
        calls.append(board_id)
        return await original(board_id)

    manager.loader = spy
    try:
        with (
            client.websocket_connect(ws_url(board["id"])) as a,
            client.websocket_connect(ws_url(board["id"])) as b,
        ):
            a.receive_json()
            b.receive_json()
    finally:
        manager.loader = original
    assert calls == [board["id"]]


def test_si_falla_la_carga_se_cierra_y_no_se_edita_sobre_un_tablero_vacio(client, board):
    original = manager.loader

    async def broken(_board_id):
        raise RuntimeError("base de datos caída")

    manager.loader = broken
    try:
        with (
            client.websocket_connect(ws_url(board["id"])) as ws,
            pytest.raises(WebSocketDisconnect) as exc,
        ):
            ws.receive_json()
        assert exc.value.code == 1011
        assert manager.rooms[board["id"]].loaded is False
    finally:
        manager.loader = original

    # Al recuperarse la base, el siguiente intento sí carga.
    save(board["id"], [rect("a")])
    with client.websocket_connect(ws_url(board["id"])) as ws:
        assert [e["id"] for e in ws.receive_json()["elements"]] == ["a"]
