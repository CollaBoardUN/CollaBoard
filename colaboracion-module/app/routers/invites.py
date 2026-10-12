"""Compartir por link.

POST   /boards/{board_id}/invite               crear link de invitación      (owner)
GET    /boards/{board_id}/invites              links activos del tablero     (owner)
DELETE /boards/{board_id}/invites/{invite_id}  desactivar un link            (owner)
GET    /invites/{token}                        ver a qué tablero invita      (logueado)
POST   /invites/{token}/accept                 unirme al tablero             (logueado)

Flujo:
  1. El owner crea un link con rol editor o viewer.
  2. Lo copia y lo manda (WhatsApp, correo...): http://front/join/<token>
  3. El otro usuario abre el link, inicia sesión si hace falta,
     ve el nombre del tablero y pulsa "Unirme".
"""

from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..auth import CurrentUser, get_current_user
from ..config import FRONTEND_URL
from ..database import get_db
from ..models import ROLE_RANK, BoardMember, Invite, Role
from ..permissions import BoardAccess, get_role, require_role
from ..schemas import InviteCreate, InviteOut, InvitePreview, JoinResult

router = APIRouter(tags=["Invitaciones"])


def _as_utc(dt: datetime | None) -> datetime | None:
    # SQLite devuelve fechas sin zona horaria; las tratamos como UTC.
    if dt is not None and dt.tzinfo is None:
        return dt.replace(tzinfo=UTC)
    return dt


def _is_active(invite: Invite) -> bool:
    if invite.revoked:
        return False
    exp = _as_utc(invite.expires_at)
    return exp is None or exp > datetime.now(UTC)


def _to_out(invite: Invite) -> InviteOut:
    return InviteOut(
        id=invite.id,
        token=invite.token,
        url=f"{FRONTEND_URL.rstrip('/')}/join/{invite.token}",
        role=invite.role,
        created_at=invite.created_at,
        expires_at=invite.expires_at,
        uses=invite.uses,
    )


def _get_active_invite(db: Session, token: str) -> Invite:
    invite = db.scalar(select(Invite).where(Invite.token == token))
    if invite is None or not _is_active(invite):
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, "El link de invitación no existe o ya expiró"
        )
    return invite


@router.post(
    "/boards/{board_id}/invite",
    response_model=InviteOut,
    status_code=status.HTTP_201_CREATED,
)
def create_invite(
    data: InviteCreate,
    access: BoardAccess = Depends(require_role(Role.owner)),
    db: Session = Depends(get_db),
):
    expires_at = (
        datetime.now(UTC) + timedelta(hours=data.expires_in_hours)
        if data.expires_in_hours
        else None
    )
    invite = Invite(
        board_id=access.board.id,
        role=Role(data.role),
        created_by=access.user.id,
        expires_at=expires_at,
    )
    db.add(invite)
    db.commit()
    return _to_out(invite)


@router.get("/boards/{board_id}/invites", response_model=list[InviteOut])
def list_invites(
    access: BoardAccess = Depends(require_role(Role.owner)),
    db: Session = Depends(get_db),
):
    invites = db.scalars(
        select(Invite).where(Invite.board_id == access.board.id).order_by(Invite.created_at.desc())
    ).all()
    return [_to_out(i) for i in invites if _is_active(i)]


@router.delete("/boards/{board_id}/invites/{invite_id}", status_code=status.HTTP_204_NO_CONTENT)
def revoke_invite(
    invite_id: str,
    access: BoardAccess = Depends(require_role(Role.owner)),
    db: Session = Depends(get_db),
):
    invite = db.get(Invite, invite_id)
    if invite is None or invite.board_id != access.board.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Invitación no encontrada")
    invite.revoked = True
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/invites/{token}", response_model=InvitePreview)
def preview_invite(
    token: str,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
):
    invite = _get_active_invite(db, token)
    current = get_role(db, invite.board_id, user.id)
    return InvitePreview(
        board_id=invite.board_id,
        board_name=invite.board.name,
        role=invite.role,
        already_member=current is not None,
        current_role=current,
    )


@router.post("/invites/{token}/accept", response_model=JoinResult)
def accept_invite(
    token: str,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
):
    invite = _get_active_invite(db, token)
    member = db.scalar(
        select(BoardMember).where(
            BoardMember.board_id == invite.board_id, BoardMember.user_id == user.id
        )
    )

    if member is None:
        member = BoardMember(
            board_id=invite.board_id,
            user_id=user.id,
            display_name=user.display_name,
            role=invite.role,
        )
        db.add(member)
        invite.uses += 1
    elif ROLE_RANK[invite.role] > ROLE_RANK[member.role]:
        # Si ya era viewer y el link es de editor, sube de rol.
        # Nunca bajamos de rol a alguien por abrir un link.
        member.role = invite.role
        invite.uses += 1

    db.commit()
    return JoinResult(board_id=invite.board_id, role=member.role)
