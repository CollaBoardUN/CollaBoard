"""VERIFICACIÓN DE PERMISOS — Policy Decision Point (PDP) e interceptor PEP local.

Toda decisión sale de la matriz `POLICY_MATRIX` en `app/policy.py`.
Un tablero con `status != "active"` (`deleting` o `deleted`) se comporta como
inexistente (404) para bloquear cualquier acceso, dibujo, chat o invitación.
"""

from dataclasses import dataclass

from fastapi import Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from .auth import CurrentUser, get_current_user
from .database import get_db
from .models import Board, BoardMember, BoardStatus, Role
from .policy import (
    ROLE_DEFAULT_ACTION,
    Action,
    is_action_allowed,
    minimum_role_for,
)


@dataclass
class BoardAccess:
    board: Board
    role: Role
    user: CurrentUser
    action: Action | None = None


def get_active_board(db: Session, board_id: str) -> Board | None:
    """Devuelve el tablero solo si existe y su estado es 'active'."""
    board = db.get(Board, board_id)
    if board is None or board.status != BoardStatus.active.value:
        return None
    return board


def get_role(db: Session, board_id: str, user_id: str) -> Role | None:
    """Rol del usuario en el tablero activo, o None si no es miembro / tablero inactivo."""
    board = get_active_board(db, board_id)
    if board is None:
        return None
    return db.scalar(
        select(BoardMember.role).where(
            BoardMember.board_id == board_id, BoardMember.user_id == user_id
        )
    )


def can(role: Role | None, minimum: Role | Action | str) -> bool:
    """Evalúa en la política única si `role` tiene permitida la acción o alcanza el rol."""
    if role is None:
        return False
    action = ROLE_DEFAULT_ACTION[minimum] if isinstance(minimum, Role) else Action(minimum)
    return is_action_allowed(role, action)


def require_action(action: Action | str):
    """Fábrica de dependencias PEP local: consulta la tabla de política del PDP para `action`.

    - 404 si el tablero no existe, está inactivo o el usuario no es miembro
      (no revelamos que existe un tablero ajeno).
    - 403 si es miembro pero la política RBAC no permite `action` a su rol.
    """
    target_action = Action(action)
    required_role = minimum_role_for(target_action)

    def dependency(
        board_id: str,
        db: Session = Depends(get_db),
        user: CurrentUser = Depends(get_current_user),
    ) -> BoardAccess:
        board = get_active_board(db, board_id)
        role = get_role(db, board_id, user.id) if board else None
        if board is None or role is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Tablero no encontrado")
        if not is_action_allowed(role, target_action):
            raise HTTPException(
                status.HTTP_403_FORBIDDEN,
                f"Necesitas rol '{required_role.value}' para '{target_action.value}' "
                f"y tienes '{role.value}'",
            )
        return BoardAccess(board=board, role=role, user=user, action=target_action)

    return dependency


def require_role(minimum: Role):
    """Compatibilidad con endpoints que piden rol mínimo: delega en `require_action`."""
    return require_action(ROLE_DEFAULT_ACTION[minimum])
