"""Pruebas unitarias y matriciales de la política única RBAC (PDP · Escenario S5)."""

import pytest

from app.models import Role
from app.policy import (
    POLICY_MATRIX,
    Action,
    is_action_allowed,
    minimum_role_for,
    permissions_for_role,
    policy_as_dict,
)

from .conftest import invite, join, service_headers


def test_tabla_politica_cubre_todas_las_acciones_y_roles():
    table = policy_as_dict()
    assert set(table.keys()) == {a.value for a in Action}

    # Viewer: solo lectura + cursor + resync + chat + salirse
    viewer_perms = set(permissions_for_role(Role.viewer))
    assert {
        "board:view",
        "member:list",
        "member:leave",
        "canvas:view",
        "canvas:cursor",
        "canvas:resync",
        "canvas:version:list",
        "canvas:version:read",
        "chat:read",
        "chat:send",
        "chat:connect",
    } == viewer_perms

    # Editor: suma edición de lienzo y versiones manuales/restauración, pero NO borrado ni gestión
    editor_perms = set(permissions_for_role(Role.editor))
    assert viewer_perms.issubset(editor_perms)
    assert {
        "canvas:edit",
        "canvas:draft",
        "canvas:version:create",
        "canvas:version:rename",
        "canvas:version:restore",
    }.issubset(editor_perms)
    assert "board:rename" not in editor_perms
    assert "board:delete" not in editor_perms
    assert "member:manage" not in editor_perms
    assert "invite:create" not in editor_perms
    assert "canvas:version:delete" not in editor_perms

    # Owner: todas las acciones salvo member:leave (el dueño no abandona su tablero: lo borra)
    owner_perms = set(permissions_for_role(Role.owner))
    assert "board:rename" in owner_perms
    assert "board:delete" in owner_perms
    assert "member:manage" in owner_perms
    assert "invite:create" in owner_perms
    assert "canvas:version:delete" in owner_perms
    assert "member:leave" not in owner_perms


@pytest.mark.parametrize("action", list(Action))
def test_pdp_endpoint_evalua_matriz_completa_rol_por_accion(
    client, ana, beto, caro, board, action: Action
):
    join(client, beto, invite(client, ana, board["id"], "editor")["token"])
    join(client, caro, invite(client, ana, board["id"], "viewer")["token"])

    users = [
        ("ana", "Ana", Role.owner),
        ("beto", "Beto", Role.editor),
        ("caro", "Caro", Role.viewer),
    ]
    for uid, name, role in users:
        r = client.get(
            f"/internal/boards/{board['id']}/access",
            params={"action": action.value},
            headers=service_headers(uid, name),
        )
        assert r.status_code == 200
        body = r.json()
        expected = role in POLICY_MATRIX[action]
        assert body["role"] == role.value
        assert body["action"] == action.value
        assert body["allowed"] is expected
        assert (action.value in body["permissions"]) is expected
        assert body["cache_ttl_seconds"] >= 1


def test_pdp_rechaza_accion_desconocida_con_422(client, ana, board):
    r = client.get(
        f"/internal/boards/{board['id']}/access",
        params={"action": "accion:inexistente"},
        headers=service_headers("ana", "Ana"),
    )
    assert r.status_code == 422


def test_pdp_no_filtra_existencia_a_no_miembros(client, ana, board):
    for target in (board["id"], "tablero-que-no-existe"):
        r = client.get(
            f"/internal/boards/{target}/access",
            params={"action": "canvas:view"},
            headers=service_headers("intruso", "Intruso"),
        )
        assert r.status_code == 404
        assert r.json() == {"detail": "Tablero no encontrado"}


def test_pdp_exporta_politica_por_endpoint_interno(client):
    r = client.get("/internal/policy", headers=service_headers())
    assert r.status_code == 200
    data = r.json()
    assert data["pdp"] == "collaboration-api"
    assert data["actions"]["canvas:edit"] == ["editor", "owner"]
    assert data["actions"]["canvas:version:delete"] == ["owner"]
    assert minimum_role_for(Action.canvas_edit) == Role.editor
    assert is_action_allowed(None, Action.board_view) is False
