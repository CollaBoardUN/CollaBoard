"""Verificación de permisos contra el microservicio de Colaboración (HTTP interno).

El backend de Pizarra (CanvasDB) no consulta tablas de BoardDB directamente.
"""

from dataclasses import dataclass
from typing import Any

from fastapi import Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from .auth import CurrentUser, get_current_user
from .config import AUTH_DEV_MODE
from .database import get_db
from .internal_client import check_board_access
from .models import ROLE_RANK, Role


@dataclass
class BoardRef:
    id: str


@dataclass
class BoardAccess:
    board: Any
    role: Role
    user: CurrentUser


def can(role: Role | None, minimum: Role) -> bool:
    """¿El rol alcanza el mínimo pedido? (viewer < editor < owner)"""
    return role is not None and ROLE_RANK.get(role, 0) >= ROLE_RANK.get(minimum, 0)


async def get_role_remote(board_id: str, user_id: str, token: str | None = None) -> Role | None:
    """Consulta asíncrona de acceso y rol contra Colaboración por HTTP interno."""
    exists, role_str = await check_board_access(board_id, user_id, token)
    if not exists or not role_str:
        return None
    try:
        return Role(role_str)
    except ValueError:
        return None


def get_role(db: Session, board_id: str, user_id: str) -> Role | None:
    """Función de compatibilidad: consulta local sólo si la tabla existe en sesión local."""
    try:
        from .models import BoardMember

        return db.scalar(
            select(BoardMember.role).where(
                BoardMember.board_id == board_id, BoardMember.user_id == user_id
            )
        )
    except Exception:
        return None


def require_role(minimum: Role):
    """Fábrica de dependencias asíncrona: valida el rol mínimo vía HTTP interno."""

    async def dependency(
        board_id: str,
        user: CurrentUser = Depends(get_current_user),
        db: Session = Depends(get_db),
    ) -> BoardAccess:
        # 1. Intentar validar vía HTTP interno con Colaboración
        role = await get_role_remote(board_id, user.id)

        # 2. Si no se obtuvo rol por HTTP (ej. entorno de tests), verificar fallback local
        if role is None and AUTH_DEV_MODE:
            local_role = get_role(db, board_id, user.id)
            if local_role is not None:
                role = local_role

        if role is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Tablero no encontrado")

        if not can(role, minimum):
            raise HTTPException(
                status.HTTP_403_FORBIDDEN,
                f"Necesitas rol '{minimum.value}' y tienes '{role.value}'",
            )

        board = None
        try:
            from .models import Board

            board = db.get(Board, board_id)
        except Exception:
            pass
        if board is None:
            board = BoardRef(id=board_id)

        return BoardAccess(board=board, role=role, user=user)

    return dependency
