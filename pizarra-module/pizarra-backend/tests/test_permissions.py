"""Tests de la función que reutilizan las Personas 2, 3 y 4."""

from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from app.database import SessionLocal
from app.models import Role
from app.permissions import BoardAccess, can, get_role, require_role

from .conftest import invite, join


def test_jerarquia_de_roles():
    assert can(Role.owner, Role.editor)
    assert can(Role.editor, Role.editor)
    assert can(Role.editor, Role.viewer)
    assert not can(Role.viewer, Role.editor)
    assert not can(None, Role.viewer)


def test_get_role_para_websocket(client, ana, beto, board):
    join(client, beto, invite(client, ana, board["id"], "viewer")["token"])
    with SessionLocal() as db:
        assert get_role(db, board["id"], "ana") == Role.owner
        assert get_role(db, board["id"], "beto") == Role.viewer
        assert get_role(db, board["id"], "intruso") is None


def test_require_role_en_un_endpoint_de_otro_modulo(client, ana, beto, caro, board):
    """Simula un endpoint de la Persona 2 que exige rol editor."""
    from app.main import app

    demo = FastAPI()
    demo.dependency_overrides = app.dependency_overrides

    @demo.post("/boards/{board_id}/elements")
    def crear_elemento(access: BoardAccess = Depends(require_role(Role.editor))):
        return {"ok": True, "role": access.role}

    join(client, beto, invite(client, ana, board["id"], "editor")["token"])
    join(client, caro, invite(client, ana, board["id"], "viewer")["token"])

    c = TestClient(demo)
    url = f"/boards/{board['id']}/elements"
    assert c.post(url, headers=ana).json() == {"ok": True, "role": "owner"}
    assert c.post(url, headers=beto).status_code == 200
    assert c.post(url, headers=caro).status_code == 403
    assert c.post(url, headers={"Authorization": "Bearer x"}).status_code == 401
