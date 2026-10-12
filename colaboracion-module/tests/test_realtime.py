"""Tests del WebSocket de tiempo real."""

import pytest
from starlette.websockets import WebSocketDisconnect

from .conftest import invite, join, token_for


def url(board_id: str, user: str, name: str | None = None) -> str:
    return f"/ws/boards/{board_id}?token={token_for(user, name)}"


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
        **extra,
    }


def add(eid: str, **extra) -> dict:
    return {"op": "add", "element": rect(eid, **extra)}


def next_of(ws, kind: str) -> dict:
    """Lee mensajes hasta encontrar uno del tipo pedido."""
    for _ in range(20):
        message = ws.receive_json()
        if message["type"] == kind:
            return message
    raise AssertionError(f"No llegó ningún mensaje '{kind}'")


@pytest.fixture
def shared(client, ana, beto, board):
    """Tablero de Ana compartido con Beto como editor."""
    join(client, beto, invite(client, ana, board["id"], "editor")["token"])
    return board["id"]


def test_rechaza_token_invalido(client, board):
    with (
        client.websocket_connect(f"/ws/boards/{board['id']}?token=basura") as ws,
        pytest.raises(WebSocketDisconnect) as exc,
    ):
        ws.receive_json()
    assert exc.value.code == 4401


def test_rechaza_a_quien_no_es_miembro(client, board):
    with (
        client.websocket_connect(url(board["id"], "intruso")) as ws,
        pytest.raises(WebSocketDisconnect) as exc,
    ):
        ws.receive_json()
    assert exc.value.code == 4403


def test_al_conectar_recibe_el_estado_y_la_presencia(client, board):
    with client.websocket_connect(url(board["id"], "ana", "Ana")) as ws:
        sync = ws.receive_json()
    assert sync["type"] == "sync"
    assert sync["seq"] == 0
    assert sync["elements"] == []
    assert sync["you"]["user_id"] == "ana"
    assert [p["name"] for p in sync["peers"]] == ["Ana"]


def test_un_trazo_llega_al_otro_y_al_autor_con_el_mismo_seq(client, shared):
    with (
        client.websocket_connect(url(shared, "ana", "Ana")) as a,
        client.websocket_connect(url(shared, "beto", "Beto")) as b,
    ):
        next_of(a, "sync")
        next_of(b, "sync")
        a.send_json({"type": "ops", "ops": [add("r1")]})
        de_a = next_of(a, "ops")
        de_b = next_of(b, "ops")

    assert de_a["seq"] == de_b["seq"] == 1
    assert de_b["user_id"] == "ana"
    assert de_b["ops"][0]["element"]["id"] == "r1"


def test_mover_y_borrar_se_propagan_en_orden(client, shared):
    with (
        client.websocket_connect(url(shared, "ana")) as a,
        client.websocket_connect(url(shared, "beto")) as b,
    ):
        next_of(a, "sync")
        next_of(b, "sync")
        a.send_json({"type": "ops", "ops": [add("r1")]})
        a.send_json({"type": "ops", "ops": [{"op": "update", "id": "r1", "patch": {"x": 99}}]})
        a.send_json({"type": "ops", "ops": [{"op": "delete", "id": "r1"}]})
        recibidos = [next_of(b, "ops") for _ in range(3)]

    assert [m["seq"] for m in recibidos] == [1, 2, 3]
    assert [m["ops"][0]["op"] for m in recibidos] == ["add", "update", "delete"]
    assert recibidos[1]["ops"][0]["patch"] == {"x": 99}


def test_quien_entra_despues_recibe_lo_ya_dibujado(client, shared):
    with client.websocket_connect(url(shared, "ana")) as a:
        next_of(a, "sync")
        a.send_json({"type": "ops", "ops": [add("r1"), add("r2")]})
        next_of(a, "ops")

        with client.websocket_connect(url(shared, "beto")) as b:
            sync = next_of(b, "sync")

    assert [e["id"] for e in sync["elements"]] == ["r1", "r2"]
    assert sync["seq"] == 1


def test_al_reconectar_el_estado_sigue_en_el_servidor(client, board):
    with client.websocket_connect(url(board["id"], "ana")) as a:
        next_of(a, "sync")
        a.send_json({"type": "ops", "ops": [add("r1")]})
        next_of(a, "ops")

    with client.websocket_connect(url(board["id"], "ana")) as a:
        sync = next_of(a, "sync")
    assert [e["id"] for e in sync["elements"]] == ["r1"]


def test_resync_devuelve_el_estado_completo(client, board):
    with client.websocket_connect(url(board["id"], "ana")) as a:
        next_of(a, "sync")
        a.send_json({"type": "ops", "ops": [add("r1")]})
        next_of(a, "ops")
        a.send_json({"type": "resync"})
        sync = next_of(a, "sync")
    assert sync["seq"] == 1
    assert len(sync["elements"]) == 1


def test_el_viewer_no_puede_dibujar(client, ana, beto, board):
    join(client, beto, invite(client, ana, board["id"], "viewer")["token"])
    with (
        client.websocket_connect(url(board["id"], "ana")) as a,
        client.websocket_connect(url(board["id"], "beto")) as b,
    ):
        next_of(a, "sync")
        next_of(b, "sync")
        b.send_json({"type": "ops", "ops": [add("r1")]})
        error = next_of(b, "error")
        a.send_json({"type": "resync"})
        sync = next_of(a, "sync")

    assert error["code"] == "forbidden"
    assert sync["elements"] == []


def test_presencia_al_entrar_y_salir(client, shared):
    with client.websocket_connect(url(shared, "ana", "Ana")) as a:
        next_of(a, "sync")
        with client.websocket_connect(url(shared, "beto", "Beto")) as b:
            next_of(b, "sync")
            entra = next_of(a, "presence")
            assert {p["user_id"] for p in entra["peers"]} == {"ana", "beto"}
        sale = next_of(a, "presence")
    assert [p["user_id"] for p in sale["peers"]] == ["ana"]


def test_el_cursor_llega_a_los_demas_pero_no_al_autor(client, shared):
    with (
        client.websocket_connect(url(shared, "ana")) as a,
        client.websocket_connect(url(shared, "beto")) as b,
    ):
        next_of(a, "sync")
        sync_b = next_of(b, "sync")
        a.send_json({"type": "cursor", "x": 10, "y": 20})
        cursor = next_of(b, "cursor")
        # Si el cursor se hubiera devuelto a Ana, llegaría antes que este pong.
        a.send_json({"type": "ping"})
        siguiente = next_of(a, "pong")

    assert (cursor["x"], cursor["y"]) == (10, 20)
    assert cursor["conn"] != sync_b["you"]["conn"]
    assert siguiente["type"] == "pong"


def test_el_trazo_en_curso_llega_a_los_demas_sin_consumir_seq(client, shared):
    with (
        client.websocket_connect(url(shared, "ana")) as a,
        client.websocket_connect(url(shared, "beto")) as b,
    ):
        next_of(a, "sync")
        next_of(b, "sync")
        a.send_json({"type": "draft", "element": rect("tmp")})
        draft = next_of(b, "draft")
        a.send_json({"type": "ops", "ops": [add("tmp")]})
        ops = next_of(b, "ops")

    assert draft["element"]["id"] == "tmp"
    assert ops["seq"] == 1


def test_ignora_operaciones_invalidas_y_fija_el_autor(client, board):
    with client.websocket_connect(url(board["id"], "ana")) as a:
        next_of(a, "sync")
        a.send_json(
            {
                "type": "ops",
                "ops": [
                    {"op": "add", "element": {"id": "x", "type": "evil", "x": 0, "y": 0}},
                    {"op": "add", "element": rect("y", width="ancho")},
                    {"op": "update", "id": "no-existe", "patch": {"x": 1}},
                    {"op": "delete", "id": "no-existe"},
                    "basura",
                    add("ok", authorId="otro", script="<b>"),
                ],
            }
        )
        ops = next_of(a, "ops")

    assert len(ops["ops"]) == 1
    element = ops["ops"][0]["element"]
    assert element["id"] == "ok"
    assert element["authorId"] == "ana"
    assert "script" not in element


def test_mensajes_malformados_no_rompen_la_conexion(client, board):
    with client.websocket_connect(url(board["id"], "ana")) as a:
        next_of(a, "sync")
        a.send_text("{no es json")
        assert next_of(a, "error")["code"] == "bad_message"
        a.send_json({"type": "ping"})
        assert next_of(a, "pong")


def test_si_le_quitan_el_acceso_se_corta_la_conexion(client, ana, shared):
    with client.websocket_connect(url(shared, "beto")) as b:
        next_of(b, "sync")
        assert client.delete(f"/boards/{shared}/members/beto", headers=ana).status_code == 204
        b.send_json({"type": "ops", "ops": [add("r1")]})
        with pytest.raises(WebSocketDisconnect) as exc:
            b.receive_json()
    assert exc.value.code == 4403


def test_el_servidor_confirma_cada_lote_con_su_ref(client, board):
    with client.websocket_connect(url(board["id"], "ana")) as a:
        next_of(a, "sync")
        a.send_json({"type": "ops", "ref": 7, "ops": [add("r1")]})
        ack = next_of(a, "ack")
        a.send_json({"type": "ops", "ref": 8, "ops": [{"op": "delete", "id": "no-existe"}]})
        ack_vacio = next_of(a, "ack")

    assert ack == {"type": "ack", "ref": 7, "seq": 1}
    assert ack_vacio == {"type": "ack", "ref": 8, "seq": None}
