"""VERIFICACIÓN DE PERMISOS — la pieza que usan las otras 3 personas.

Dos formas de usarla:

1) En un endpoint HTTP (Personas 2 y 4), como dependencia:

    from app.permissions import require_role, BoardAccess
    from app.models import Role

    @router.get("/boards/{board_id}/elements")
    def list_elements(access: BoardAccess = Depends(require_role(Role.viewer))):
        # Si llegas aquí, el usuario tiene al menos rol viewer.
        # access.board, access.role y access.user están disponibles.
        ...

2) Fuera de una dependencia, por ejemplo en el WebSocket (Persona 3):

    from app.permissions import get_role, can
    role = get_role(db, board_id, user.id)
    if role is None:
        await websocket.close(code=4403)          # no es miembro
    if not can(role, Role.editor):
        ...                                         # ignorar eventos de dibujo
"""

from dataclasses import dataclass

from fastapi import Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from .auth import CurrentUser, get_current_user
from .database import get_db
from .models import ROLE_RANK, Board, BoardMember, Role


@dataclass
class BoardAccess:
    board: Board
    role: Role
    user: CurrentUser


def get_role(db: Session, board_id: str, user_id: str) -> Role | None:
    """Rol del usuario en el tablero, o None si no es miembro."""
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

    - 404 si el tablero no existe o el usuario no es miembro
      (no revelamos que existe un tablero ajeno).
    - 403 si es miembro pero su rol no alcanza.
    """

    def dependency(
        board_id: str,
        db: Session = Depends(get_db),
        user: CurrentUser = Depends(get_current_user),
    ) -> BoardAccess:
        board = db.get(Board, board_id)
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
