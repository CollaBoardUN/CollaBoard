"""Tests del historial: crear, listar, restaurar, permisos y versiones automáticas."""

import time

import pytest

from app.database import SessionLocal
from app.persistence import store
from app.persistence.store import create_version, list_versions, load_state
from app.realtime.rooms import manager

from .conftest import auth, invite, join
from .test_persistence import clean_rooms, rect, save, ws_url  # noqa: F401  (fixture autouse)


def until(ws, kind: str) -> dict:
    """Lee mensajes hasta encontrar uno del tipo pedido."""
    for _ in range(40):
        message = ws.receive_json()
        if message["type"] == kind:
            return message
    raise AssertionError(f"No llegó ningún mensaje '{kind}'")


def ids(elements: list[dict]) -> list[str]:
    return [e["id"] for e in elements]


def stored_ids(board_id: str) -> list[str]:
    with SessionLocal() as db:
        return ids(load_state(db, board_id)[0])


def versions_url(board_id: str, *parts: str) -> str:
    return "/".join([f"/boards/{board_id}/versions", *parts])


def wait_for(condition, timeout: float = 3.0) -> bool:
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if condition():
            return True
        time.sleep(0.02)
    return condition()


@pytest.fixture
def slow_autosave(monkeypatch):
    """El timer no actúa: lo que se guarde tiene que venir de la acción bajo prueba."""
    from app.persistence.autosave import autosaver

    monkeypatch.setattr(autosaver, "debounce", 60)
    monkeypatch.setattr(autosaver, "max_wait", 120)


@pytest.fixture
def team(client, ana, beto, caro, board):
    """Tablero de Ana: Beto es editor y Caro es viewer."""
    join(client, beto, invite(client, ana, board["id"], "editor")["token"])
    join(client, caro, invite(client, ana, board["id"], "viewer")["token"])
    return board["id"]


# ------------------------------------------------------------------ store


def make(db, board_id, kind="auto", elements=None, **kw):
    elements = [rect("a")] if elements is None else elements
    return create_version(db, board_id, kind=kind, elements=elements, seq=1, **kw)


def test_los_numeros_son_consecutivos_por_tablero(board):
    with SessionLocal() as db:
        numbers = [make(db, board["id"], elements=[rect(str(i))]).number for i in range(3)]
    assert numbers == [1, 2, 3]


def test_dedupe_no_repite_la_ultima_version_ni_crea_una_vacia(board):
    with SessionLocal() as db:
        assert make(db, board["id"], elements=[], dedupe=True) is None  # vacío y sin versiones
        assert make(db, board["id"], dedupe=True) is not None
        assert make(db, board["id"], dedupe=True) is None  # idéntica a la última
        assert make(db, board["id"], kind="manual") is not None  # sin dedupe, siempre crea


def test_se_podan_las_automaticas_viejas(board):
    with SessionLocal() as db:
        for i in range(55):
            make(db, board["id"], elements=[rect(str(i))])
        make(db, board["id"], kind="manual", elements=[rect("m")])
        rows = list_versions(db, board["id"], limit=100)
    autos = sorted(v.number for v in rows if v.kind == "auto")
    assert len(autos) == 50
    assert autos[0] == 6 and autos[-1] == 55  # se fueron las 5 más viejas
    assert sum(v.kind == "manual" for v in rows) == 1  # las manuales no se tocan


def test_tope_de_versiones_manuales(client, ana, board, monkeypatch):
    monkeypatch.setattr(store, "MAX_MANUAL", 2)
    for _ in range(2):
        assert client.post(versions_url(board["id"]), json={}, headers=ana).status_code == 201
    r = client.post(versions_url(board["id"]), json={}, headers=ana)
    assert r.status_code == 409


# ------------------------------------------------------------------ crear y leer


def test_crear_version_usa_lo_que_hay_ahora_aunque_no_este_guardado(
    client, ana, board, slow_autosave
):
    with client.websocket_connect(ws_url(board["id"])) as ws:
        ws.receive_json()
        ws.send_json({"type": "ops", "ref": 1, "ops": [{"op": "add", "element": rect("x")}]})
        until(ws, "ack")

        r = client.post(versions_url(board["id"]), json={"name": "  Hito  "}, headers=ana)
        assert r.status_code == 201
        version = r.json()
        assert version["number"] == 1
        assert version["kind"] == "manual"
        assert version["name"] == "Hito"
        assert version["created_by"] == "ana"
        assert version["element_count"] == 1
        assert "elements" not in version

        detail = client.get(versions_url(board["id"], version["id"]), headers=ana).json()
        assert ids(detail["elements"]) == ["x"]


def test_listar_devuelve_las_mas_nuevas_primero_y_sin_elementos(client, ana, board):
    save(board["id"], [rect("a")])
    for name in ("uno", "dos"):
        client.post(versions_url(board["id"]), json={"name": name}, headers=ana)
    rows = client.get(versions_url(board["id"]), headers=ana).json()
    assert [v["name"] for v in rows] == ["dos", "uno"]
    assert all("elements" not in v for v in rows)


def test_estado_en_vivo_y_estado_guardado(client, ana, board, slow_autosave):
    with client.websocket_connect(ws_url(board["id"])) as ws:
        ws.receive_json()
        ws.send_json({"type": "ops", "ref": 1, "ops": [{"op": "add", "element": rect("v")}]})
        until(ws, "ack")
        live = client.get(f"/boards/{board['id']}/state", headers=ana).json()
        assert ids(live["elements"]) == ["v"] and live["seq"] == 1
        assert live["saved_at"] is None  # todavía no se guardó

    state_url = f"/boards/{board['id']}/state"
    assert wait_for(lambda: client.get(state_url, headers=ana).json()["saved_at"])
    manager.rooms.clear()
    stored = client.get(f"/boards/{board['id']}/state", headers=ana).json()
    assert ids(stored["elements"]) == ["v"]


# ------------------------------------------------------------------ permisos


def test_permisos_de_versiones(client, ana, beto, caro, team):
    url = versions_url(team)
    stranger = auth("intruso")

    v = client.post(url, json={"name": "base"}, headers=beto)  # editor: puede
    assert v.status_code == 201
    vid = v.json()["id"]

    assert client.post(url, json={}, headers=caro).status_code == 403  # viewer: no crea
    assert client.post(versions_url(team, vid, "restore"), headers=caro).status_code == 403
    rename = client.patch(versions_url(team, vid), json={"name": "x"}, headers=caro)
    assert rename.status_code == 403
    assert client.get(url, headers=caro).status_code == 200  # pero sí mira
    assert client.get(versions_url(team, vid), headers=caro).status_code == 200
    assert client.get(f"/boards/{team}/state", headers=caro).status_code == 200

    assert client.delete(versions_url(team, vid), headers=beto).status_code == 403  # solo owner
    assert client.delete(versions_url(team, vid), headers=ana).status_code == 204

    assert client.get(url, headers=stranger).status_code == 404  # ni existe para ajenos
    assert client.post(url, json={}, headers=stranger).status_code == 404


def test_renombrar_y_quitar_el_nombre(client, ana, board):
    vid = client.post(versions_url(board["id"]), json={"name": "a"}, headers=ana).json()["id"]
    r = client.patch(versions_url(board["id"], vid), json={"name": "b"}, headers=ana)
    assert r.json()["name"] == "b"
    r = client.patch(versions_url(board["id"], vid), json={"name": "   "}, headers=ana)
    assert r.json()["name"] is None


def test_una_version_de_otro_tablero_no_existe(client, ana, beto, board):
    other = client.post("/boards", json={"name": "Ajeno"}, headers=beto).json()
    vid = client.post(versions_url(other["id"]), json={}, headers=beto).json()["id"]
    assert client.get(versions_url(board["id"], vid), headers=ana).status_code == 404
    assert client.post(versions_url(board["id"], vid, "restore"), headers=ana).status_code == 404
    assert client.delete(versions_url(board["id"], vid), headers=ana).status_code == 404


def test_borrar_el_tablero_borra_sus_versiones(client, ana, board):
    client.post(versions_url(board["id"]), json={}, headers=ana)
    assert client.delete(f"/boards/{board['id']}", headers=ana).status_code == 204
    with SessionLocal() as db:
        assert list_versions(db, board["id"]) == []


# ------------------------------------------------------------------ restaurar


def test_restaurar_reemplaza_el_tablero_en_vivo_y_avisa_a_todos(client, ana, beto, team):
    save(team, [rect("a"), rect("b")], seq=3)
    v1 = client.post(versions_url(team), json={"name": "Base"}, headers=ana).json()

    with (
        client.websocket_connect(ws_url(team, "ana")) as wa,
        client.websocket_connect(ws_url(team, "beto")) as wb,
    ):
        wa.receive_json()
        wb.receive_json()
        wa.send_json({"type": "ops", "ref": 1, "ops": [{"op": "add", "element": rect("c")}]})
        until(wa, "ack")

        r = client.post(versions_url(team, v1["id"], "restore"), headers=beto)
        assert r.status_code == 200
        body = r.json()
        assert body["restored"]["id"] == v1["id"]
        assert body["backup"]["kind"] == "restore"
        assert body["backup"]["name"] == "Antes de restaurar v1"
        assert body["seq"] == 5  # 3 guardado + 1 de la operación "c" + 1 de restaurar

        for ws in (wa, wb):  # TODOS reciben el aviso y el tablero completo
            restored = until(ws, "restored")
            assert restored["by"] == "Beto"
            assert restored["version"]["number"] == 1
            sync = until(ws, "sync")
            assert ids(sync["elements"]) == ["a", "b"]
            assert sync["seq"] == body["seq"]

        # La copia de seguridad conserva lo que se iba a perder.
        backup = client.get(versions_url(team, body["backup"]["id"]), headers=ana).json()
        assert ids(backup["elements"]) == ["a", "b", "c"]
        assert [v["kind"] for v in client.get(versions_url(team), headers=ana).json()] == [
            "restore",
            "manual",
        ]

    # Y queda guardado en la base de datos, no solo en la sala.
    assert wait_for(lambda: stored_ids(team) == ["a", "b"])


def test_restaurar_sin_nadie_conectado(client, ana, board):
    save(board["id"], [rect("a")])
    v1 = client.post(versions_url(board["id"]), json={"name": "uno"}, headers=ana).json()
    save(board["id"], [rect("a"), rect("b")], seq=2)
    manager.rooms.clear()

    r = client.post(versions_url(board["id"], v1["id"], "restore"), headers=ana)
    assert r.status_code == 200
    with SessionLocal() as db:
        assert ids(load_state(db, board["id"])[0]) == ["a"]

    with client.websocket_connect(ws_url(board["id"])) as ws:
        assert ids(ws.receive_json()["elements"]) == ["a"]


def test_restaurar_no_duplica_la_copia_si_el_tablero_ya_estaba_igual(client, ana, board):
    save(board["id"], [rect("a")])
    v1 = client.post(versions_url(board["id"]), json={}, headers=ana).json()
    body = client.post(versions_url(board["id"], v1["id"], "restore"), headers=ana).json()
    assert body["backup"]["id"] == v1["id"]  # el estado ya estaba en la versión 1
    assert len(client.get(versions_url(board["id"]), headers=ana).json()) == 1


def test_restaurar_una_version_que_no_existe(client, ana, board):
    r = client.post(versions_url(board["id"], "no-existe", "restore"), headers=ana)
    assert r.status_code == 404


# ------------------------------------------------------------------ automáticas


def test_al_salir_la_ultima_persona_se_crea_una_version_automatica(client, ana, board):
    def draw_and_leave(eid: str) -> None:
        with client.websocket_connect(ws_url(board["id"])) as ws:
            ws.receive_json()
            ws.send_json({"type": "ops", "ref": 1, "ops": [{"op": "add", "element": rect(eid)}]})
            until(ws, "ack")

    def autos() -> list[dict]:
        rows = client.get(versions_url(board["id"]), headers=ana).json()
        return [v for v in rows if v["kind"] == "auto"]

    draw_and_leave("a")
    assert wait_for(lambda: len(autos()) == 1)
    assert autos()[0]["element_count"] == 1

    with client.websocket_connect(ws_url(board["id"])) as ws:  # entra y sale sin cambiar nada
        ws.receive_json()
    time.sleep(0.3)
    assert len(autos()) == 1  # no se duplica

    draw_and_leave("b")
    assert wait_for(lambda: len(autos()) == 2)
