from datetime import UTC, datetime, timedelta

from app.database import SessionLocal
from app.models import Invite

from .conftest import invite, join


def test_crear_link_devuelve_url_del_front(client, ana, board):
    inv = invite(client, ana, board["id"], "viewer")
    assert inv["role"] == "viewer"
    assert inv["url"] == f"http://front.test/join/{inv['token']}"
    assert inv["expires_at"] is not None
    assert len(inv["token"]) >= 40


def test_link_sin_expiracion(client, ana, board):
    r = client.post(
        f"/boards/{board['id']}/invite",
        json={"role": "editor", "expires_in_hours": None},
        headers=ana,
    )
    assert r.json()["expires_at"] is None


def test_no_se_invita_como_owner(client, ana, board):
    r = client.post(f"/boards/{board['id']}/invite", json={"role": "owner"}, headers=ana)
    assert r.status_code == 422


def test_solo_owner_crea_links(client, ana, beto, board):
    join(client, beto, invite(client, ana, board["id"])["token"])
    r = client.post(f"/boards/{board['id']}/invite", json={"role": "viewer"}, headers=beto)
    assert r.status_code == 403


def test_preview_muestra_tablero_y_rol(client, ana, beto, board):
    inv = invite(client, ana, board["id"])
    r = client.get(f"/invites/{inv['token']}", headers=beto)
    assert r.status_code == 200
    assert r.json() == {
        "board_id": board["id"],
        "board_name": "Tablero de Ana",
        "role": "editor",
        "already_member": False,
        "current_role": None,
    }


def test_preview_requiere_login(client, ana, board):
    inv = invite(client, ana, board["id"])
    assert client.get(f"/invites/{inv['token']}").status_code == 401


def test_unirse_da_el_rol_correcto(client, ana, beto, board):
    inv = invite(client, ana, board["id"], "viewer")
    assert join(client, beto, inv["token"]) == {"board_id": board["id"], "role": "viewer"}
    detalle = client.get(f"/boards/{board['id']}", headers=beto).json()
    assert detalle["my_role"] == "viewer"


def test_unirse_dos_veces_no_duplica(client, ana, beto, board):
    token = invite(client, ana, board["id"])["token"]
    join(client, beto, token)
    join(client, beto, token)
    miembros = client.get(f"/boards/{board['id']}/members", headers=ana).json()
    assert len(miembros) == 2


def test_link_editor_sube_a_viewer(client, ana, beto, board):
    join(client, beto, invite(client, ana, board["id"], "viewer")["token"])
    nuevo = invite(client, ana, board["id"], "editor")
    assert join(client, beto, nuevo["token"])["role"] == "editor"


def test_link_viewer_no_baja_a_editor(client, ana, beto, board):
    join(client, beto, invite(client, ana, board["id"], "editor")["token"])
    nuevo = invite(client, ana, board["id"], "viewer")
    assert join(client, beto, nuevo["token"])["role"] == "editor"


def test_owner_abriendo_su_link_sigue_owner(client, ana, board):
    assert join(client, ana, invite(client, ana, board["id"])["token"])["role"] == "owner"


def test_token_inexistente_da_404(client, beto):
    assert client.post("/invites/no-existe/accept", headers=beto).status_code == 404


def test_link_expirado_no_sirve(client, ana, beto, board):
    inv = invite(client, ana, board["id"])
    with SessionLocal() as db:
        db.get(Invite, inv["id"]).expires_at = datetime.now(UTC) - timedelta(hours=1)
        db.commit()
    assert client.post(f"/invites/{inv['token']}/accept", headers=beto).status_code == 404


def test_revocar_link(client, ana, beto, board):
    inv = invite(client, ana, board["id"])
    r = client.delete(f"/boards/{board['id']}/invites/{inv['id']}", headers=ana)
    assert r.status_code == 204
    assert client.post(f"/invites/{inv['token']}/accept", headers=beto).status_code == 404
    assert client.get(f"/boards/{board['id']}/invites", headers=ana).json() == []


def test_listar_links_activos_y_contador_de_usos(client, ana, beto, caro, board):
    inv = invite(client, ana, board["id"])
    join(client, beto, inv["token"])
    join(client, caro, inv["token"])
    activos = client.get(f"/boards/{board['id']}/invites", headers=ana).json()
    assert len(activos) == 1
    assert activos[0]["uses"] == 2


def test_no_se_revoca_link_de_otro_tablero(client, ana, board):
    otro = client.post("/boards", json={"name": "Otro"}, headers=ana).json()
    inv = invite(client, ana, otro["id"])
    r = client.delete(f"/boards/{board['id']}/invites/{inv['id']}", headers=ana)
    assert r.status_code == 404


def test_link_sigue_funcionando_tras_borrar_y_es_404(client, ana, beto, board):
    inv = invite(client, ana, board["id"])
    client.delete(f"/boards/{board['id']}", headers=ana)
    assert client.post(f"/invites/{inv['token']}/accept", headers=beto).status_code == 404
