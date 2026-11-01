"""VERIFICACIÓN DE PERMISOS — autoridad única de acceso a tableros.

Un tablero con `status != "active"` (`deleting` o `deleted`) se comporta como
inexistente (404) para bloquear cualquier acceso, dibujo, chat o invitación.
"""

from dataclasses import dataclass

from fastapi import Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from .auth import CurrentUser, get_current_user
from .database import get_db
from .models import ROLE_RANK, Board, BoardMember, BoardStatus, Role


@dataclass
class BoardAccess:
    board: Board
    role: Role
    user: CurrentUser


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


def can(role: Role | None, minimum: Role) -> bool:
    """¿El rol alcanza el mínimo pedido? (viewer < editor < owner)"""
    return role is not None and ROLE_RANK[role] >= ROLE_RANK[minimum]


def require_role(minimum: Role):
    """Fábrica de dependencias: exige un rol mínimo sobre {board_id}.

    - 404 si el tablero no existe, está desactivado/borrado o el usuario no es miembro
      (no revelamos que existe un tablero ajeno).
    - 403 si es miembro pero su rol no alcanza.
    """

    def dependency(
        board_id: str,
        db: Session = Depends(get_db),
        user: CurrentUser = Depends(get_current_user),
    ) -> BoardAccess:
        board = get_active_board(db, board_id)
        role = get_role(db, board_id, user.id) if board else None
        if board is None or role is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Tablero no encontrado")
        if not can(role, minimum):
            raise HTTPException(
                status.HTTP_403_FORBIDDEN,
                f"Necesitas rol '{minimum.value}' y tienes '{role.value}'",
            )
        return BoardAccess(board=board, role=role, user=user)

    return dependency
