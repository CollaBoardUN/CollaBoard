"""Política única RBAC (Policy Decision Point · PDP) de CollaBoard — Escenario S5.

Toda decisión de autorización sobre un tablero ("¿puede el usuario con rol R ejecutar
la acción A sobre este tablero?") sale de la tabla declarativa `POLICY_MATRIX` definida
en este módulo. Ningún otro microservicio (Pizarra, Chat) mantiene jerarquías propias
de permisos: actúan como Policy Enforcement Points (PEP) que consultan al PDP en
`GET /internal/boards/{board_id}/access?action=<accion>` (o evalúan el conjunto
`permissions` firmado en la decisión del PDP dentro de su ventana de caché).
"""

import enum

from .models import ROLE_RANK, Role


class Action(enum.StrEnum):
    """Catálogo cerrado de acciones de negocio sobre un tablero."""

    # --- Dominio Colaboración (tableros, miembros e invitaciones)
    board_view = "board:view"
    board_rename = "board:rename"
    board_delete = "board:delete"
    member_list = "member:list"
    member_manage = "member:manage"
    member_leave = "member:leave"
    invite_create = "invite:create"
    invite_list = "invite:list"
    invite_revoke = "invite:revoke"

    # --- Dominio Pizarra (estado, historial de versiones y tiempo real WS)
    canvas_view = "canvas:view"
    canvas_cursor = "canvas:cursor"
    canvas_resync = "canvas:resync"
    canvas_edit = "canvas:edit"
    canvas_draft = "canvas:draft"
    canvas_version_list = "canvas:version:list"
    canvas_version_read = "canvas:version:read"
    canvas_version_create = "canvas:version:create"
    canvas_version_rename = "canvas:version:rename"
    canvas_version_restore = "canvas:version:restore"
    canvas_version_delete = "canvas:version:delete"

    # --- Dominio Chat (historial, envío, recibos de lectura y tiempo real WS)
    chat_read = "chat:read"
    chat_send = "chat:send"
    chat_connect = "chat:connect"


_ALL_MEMBERS: frozenset[Role] = frozenset({Role.viewer, Role.editor, Role.owner})
_EDITORS_AND_OWNER: frozenset[Role] = frozenset({Role.editor, Role.owner})
_ONLY_OWNER: frozenset[Role] = frozenset({Role.owner})

# Tabla única de política RBAC (Acción -> Conjunto explícito de roles autorizados).
POLICY_MATRIX: dict[Action, frozenset[Role]] = {
    # Colaboración
    Action.board_view: _ALL_MEMBERS,
    Action.board_rename: _ONLY_OWNER,
    Action.board_delete: _ONLY_OWNER,
    Action.member_list: _ALL_MEMBERS,
    Action.member_manage: _ONLY_OWNER,
    Action.member_leave: frozenset({Role.viewer, Role.editor}),
    Action.invite_create: _ONLY_OWNER,
    Action.invite_list: _ONLY_OWNER,
    Action.invite_revoke: _ONLY_OWNER,
    # Pizarra
    Action.canvas_view: _ALL_MEMBERS,
    Action.canvas_cursor: _ALL_MEMBERS,
    Action.canvas_resync: _ALL_MEMBERS,
    Action.canvas_edit: _EDITORS_AND_OWNER,
    Action.canvas_draft: _EDITORS_AND_OWNER,
    Action.canvas_version_list: _ALL_MEMBERS,
    Action.canvas_version_read: _ALL_MEMBERS,
    Action.canvas_version_create: _EDITORS_AND_OWNER,
    Action.canvas_version_rename: _EDITORS_AND_OWNER,
    Action.canvas_version_restore: _EDITORS_AND_OWNER,
    Action.canvas_version_delete: _ONLY_OWNER,
    # Chat
    Action.chat_read: _ALL_MEMBERS,
    Action.chat_send: _ALL_MEMBERS,
    Action.chat_connect: _ALL_MEMBERS,
}

# Acción representativa asociada a un rol mínimo (compatibilidad con require_role(Role)).
ROLE_DEFAULT_ACTION: dict[Role, Action] = {
    Role.viewer: Action.board_view,
    Role.editor: Action.canvas_edit,
    Role.owner: Action.board_rename,
}


def minimum_role_for(action: Action | str) -> Role:
    """Devuelve el rol de menor rango que tiene permitida la acción."""
    act = Action(action)
    allowed = POLICY_MATRIX[act]
    return min(allowed, key=lambda r: ROLE_RANK[r])


def permissions_for_role(role: Role | None) -> list[str]:
    """Lista ordenada de todas las acciones que la política concede al rol dado."""
    if role is None:
        return []
    return [act.value for act, roles in POLICY_MATRIX.items() if role in roles]


def is_action_allowed(role: Role | None, action: Action | str) -> bool:
    """Evalúa en la tabla de política si `role` tiene permitida la `action`."""
    if role is None:
        return False
    try:
        act = Action(action)
    except ValueError:
        return False
    return role in POLICY_MATRIX.get(act, frozenset())


def policy_as_dict() -> dict[str, list[str]]:
    """Exporta la tabla de política completa (acción -> roles ordenados por jerarquía)."""
    return {
        act.value: [r.value for r in sorted(roles, key=lambda role: ROLE_RANK[role])]
        for act, roles in POLICY_MATRIX.items()
    }
