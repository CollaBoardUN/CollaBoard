from .conftest import invite, join


def test_crear_tablero_me_deja_como_owner(client, ana, board):
    assert board["name"] == "Tablero de Ana"
    assert board["my_role"] == "owner"
    assert board["owner_id"] == "ana"
    assert board["member_count"] == 1


def test_nombre_vacio_o_espacios_es_rechazado(client, ana):
    assert client.post("/boards", json={"name": ""}, headers=ana).status_code == 422
    assert client.post("/boards", json={"name": "   "}, headers=ana).status_code == 422


def test_nombre_se_limpia_de_espacios(client, ana):
    r = client.post("/boards", json={"name": "  Ideas  "}, headers=ana)
    assert r.json()["name"] == "Ideas"


def test_listar_solo_mis_tableros(client, ana, beto, board):
    client.post("/boards", json={"name": "De Beto"}, headers=beto)
    mios = client.get("/boards", headers=ana).json()
    assert [b["name"] for b in mios] == ["Tablero de Ana"]


def test_listar_incluye_tableros_compartidos_con_mi_rol(client, ana, beto, board):
    join(client, beto, invite(client, ana, board["id"], "viewer")["token"])
    lista = client.get("/boards", headers=beto).json()
    assert len(lista) == 1
    assert lista[0]["my_role"] == "viewer"
    assert lista[0]["member_count"] == 2


def test_ver_detalle(client, ana, board):
    r = client.get(f"/boards/{board['id']}", headers=ana)
    assert r.status_code == 200
    assert r.json()["my_role"] == "owner"


def test_tablero_ajeno_da_404_no_403(client, beto, board):
    # No revelamos que el tablero existe.
    assert client.get(f"/boards/{board['id']}", headers=beto).status_code == 404


def test_tablero_inexistente_da_404(client, ana):
    assert client.get("/boards/no-existe", headers=ana).status_code == 404


def test_owner_renombra(client, ana, board):
    r = client.patch(f"/boards/{board['id']}", json={"name": "Nuevo"}, headers=ana)
    assert r.status_code == 200
    assert r.json()["name"] == "Nuevo"


def test_editor_no_puede_renombrar(client, ana, beto, board):
    join(client, beto, invite(client, ana, board["id"], "editor")["token"])
    r = client.patch(f"/boards/{board['id']}", json={"name": "X"}, headers=beto)
    assert r.status_code == 403


def test_owner_borra_y_desaparece_para_todos(client, ana, beto, board):
    join(client, beto, invite(client, ana, board["id"])["token"])
    assert client.delete(f"/boards/{board['id']}", headers=ana).status_code == 204
    assert client.get("/boards", headers=ana).json() == []
    assert client.get("/boards", headers=beto).json() == []


def test_editor_no_puede_borrar(client, ana, beto, board):
    join(client, beto, invite(client, ana, board["id"])["token"])
    assert client.delete(f"/boards/{board['id']}", headers=beto).status_code == 403


# ------------------------------------------------------------ miembros


def test_listar_miembros_con_nombre(client, ana, beto, board):
    join(client, beto, invite(client, ana, board["id"], "viewer")["token"])
    miembros = client.get(f"/boards/{board['id']}/members", headers=beto).json()
    assert [(m["user_id"], m["display_name"], m["role"]) for m in miembros] == [
        ("ana", "Ana", "owner"),
        ("beto", "Beto", "viewer"),
    ]


def test_owner_cambia_rol(client, ana, beto, board):
    join(client, beto, invite(client, ana, board["id"], "viewer")["token"])
    r = client.patch(f"/boards/{board['id']}/members/beto", json={"role": "editor"}, headers=ana)
    assert r.status_code == 200
    assert r.json()["role"] == "editor"


def test_no_se_puede_ascender_a_owner(client, ana, beto, board):
    join(client, beto, invite(client, ana, board["id"])["token"])
    r = client.patch(f"/boards/{board['id']}/members/beto", json={"role": "owner"}, headers=ana)
    assert r.status_code == 422


def test_no_se_puede_cambiar_rol_del_owner(client, ana, board):
    r = client.patch(f"/boards/{board['id']}/members/ana", json={"role": "viewer"}, headers=ana)
    assert r.status_code == 400


def test_editor_no_cambia_roles(client, ana, beto, caro, board):
    join(client, beto, invite(client, ana, board["id"])["token"])
    join(client, caro, invite(client, ana, board["id"], "viewer")["token"])
    r = client.patch(f"/boards/{board['id']}/members/caro", json={"role": "editor"}, headers=beto)
    assert r.status_code == 403


def test_owner_quita_miembro(client, ana, beto, board):
    join(client, beto, invite(client, ana, board["id"])["token"])
    assert client.delete(f"/boards/{board['id']}/members/beto", headers=ana).status_code == 204
    assert client.get(f"/boards/{board['id']}", headers=beto).status_code == 404


def test_miembro_puede_salirse(client, ana, beto, board):
    join(client, beto, invite(client, ana, board["id"])["token"])
    assert client.delete(f"/boards/{board['id']}/members/beto", headers=beto).status_code == 204


def test_miembro_no_puede_quitar_a_otro(client, ana, beto, caro, board):
    join(client, beto, invite(client, ana, board["id"])["token"])
    join(client, caro, invite(client, ana, board["id"])["token"])
    assert client.delete(f"/boards/{board['id']}/members/caro", headers=beto).status_code == 403


def test_owner_no_puede_salirse(client, ana, board):
    assert client.delete(f"/boards/{board['id']}/members/ana", headers=ana).status_code == 400


def test_quitar_no_miembro_da_404(client, ana, board):
    assert client.delete(f"/boards/{board['id']}/members/nadie", headers=ana).status_code == 404
