"""Endpoints de tableros y miembros.

POST   /boards                              crear (quien crea queda como owner)
GET    /boards                              mis tableros (en los que soy miembro)
GET    /boards/{board_id}                   detalle + mi rol             (viewer+)
PATCH  /boards/{board_id}                   renombrar                    (owner)
DELETE /boards/{board_id}                   borrar                       (owner)
GET    /boards/{board_id}/members           lista de miembros            (viewer+)
PATCH  /boards/{board_id}/members/{user_id} cambiar rol de un miembro    (owner)
DELETE /boards/{board_id}/members/{user_id} quitar miembro / salirme     (owner, o uno mismo)
"""

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..auth import CurrentUser, get_current_user
from ..database import get_db
from ..models import Board, BoardMember, Role
from ..permissions import BoardAccess, require_role
from ..schemas import BoardCreate, BoardOut, BoardUpdate, MemberOut, MemberRoleUpdate

router = APIRouter(prefix="/boards", tags=["Tableros"])


def _count_members(db: Session, board_id: str) -> int:
    return (
        db.scalar(
            select(func.count()).select_from(BoardMember).where(BoardMember.board_id == board_id)
        )
        or 0
    )


def _to_out(db: Session, board: Board, role: Role) -> BoardOut:
    return BoardOut(
        id=board.id,
        name=board.name,
        owner_id=board.owner_id,
        my_role=role,
        member_count=_count_members(db, board.id),
        created_at=board.created_at,
        updated_at=board.updated_at,
    )


@router.post("", response_model=BoardOut, status_code=status.HTTP_201_CREATED)
def create_board(
    data: BoardCreate,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
):
    board = Board(name=data.name, owner_id=user.id)
    board.members.append(
        BoardMember(user_id=user.id, display_name=user.display_name, role=Role.owner)
    )
    db.add(board)
    db.commit()
    return _to_out(db, board, Role.owner)


@router.get("", response_model=list[BoardOut])
def list_my_boards(
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
):
    member_count = (
        select(BoardMember.board_id, func.count().label("n"))
        .group_by(BoardMember.board_id)
        .subquery()
    )
    rows = db.execute(
        select(Board, BoardMember.role, member_count.c.n)
        .join(BoardMember, BoardMember.board_id == Board.id)
        .join(member_count, member_count.c.board_id == Board.id)
        .where(BoardMember.user_id == user.id)
        .order_by(Board.updated_at.desc())
    ).all()
    return [
        BoardOut(
            id=b.id,
            name=b.name,
            owner_id=b.owner_id,
            my_role=role,
            member_count=n,
            created_at=b.created_at,
            updated_at=b.updated_at,
        )
        for b, role, n in rows
    ]


@router.get("/{board_id}", response_model=BoardOut)
def get_board(
    access: BoardAccess = Depends(require_role(Role.viewer)),
    db: Session = Depends(get_db),
):
    return _to_out(db, access.board, access.role)


@router.patch("/{board_id}", response_model=BoardOut)
def rename_board(
    data: BoardUpdate,
    access: BoardAccess = Depends(require_role(Role.owner)),
    db: Session = Depends(get_db),
):
    board = db.merge(access.board)
    board.name = data.name
    db.commit()
    return _to_out(db, board, access.role)


@router.delete("/{board_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_board(
    access: BoardAccess = Depends(require_role(Role.owner)),
    db: Session = Depends(get_db),
):
    db.delete(db.merge(access.board))
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ---------------------------------------------------------------- miembros


@router.get("/{board_id}/members", response_model=list[MemberOut])
def list_members(
    access: BoardAccess = Depends(require_role(Role.viewer)),
    db: Session = Depends(get_db),
):
    return db.scalars(
        select(BoardMember)
        .where(BoardMember.board_id == access.board.id)
        .order_by(BoardMember.joined_at)
    ).all()


def _get_member(db: Session, board_id: str, user_id: str) -> BoardMember:
    member = db.scalar(
        select(BoardMember).where(BoardMember.board_id == board_id, BoardMember.user_id == user_id)
    )
    if member is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Ese usuario no es miembro")
    return member


@router.patch("/{board_id}/members/{user_id}", response_model=MemberOut)
def change_member_role(
    user_id: str,
    data: MemberRoleUpdate,
    access: BoardAccess = Depends(require_role(Role.owner)),
    db: Session = Depends(get_db),
):
    member = _get_member(db, access.board.id, user_id)
    if member.role == Role.owner:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "No puedes cambiar el rol del dueño")
    member.role = Role(data.role)
    db.commit()
    return member


@router.delete("/{board_id}/members/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove_member(
    user_id: str,
    access: BoardAccess = Depends(require_role(Role.viewer)),
    db: Session = Depends(get_db),
):
    is_self = user_id == access.user.id
    if not is_self and access.role != Role.owner:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Solo el dueño puede quitar miembros")

    member = _get_member(db, access.board.id, user_id)
    if member.role == Role.owner:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "El dueño no puede salir del tablero; si quiere, puede borrarlo",
        )
    db.delete(member)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
