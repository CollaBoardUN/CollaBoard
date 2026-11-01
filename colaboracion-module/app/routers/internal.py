"""Endpoints internos de Colaboración (/internal/*).

Consumidos por Pizarra y Chat en la red interna de contenedores. El API Gateway
bloquea cualquier solicitud externa a `/internal/*`.

Rutas:
  GET   /internal/boards/{board_id}/access      resolver existencia y rol del usuario
  GET   /internal/boards/{board_id}/recipients  destinatarios autorizados (excluye autor)
  PATCH /internal/boards/{board_id}/metadata    callback de guardado de Pizarra
"""

import hmac
from datetime import UTC

from fastapi import (
    APIRouter,
    Cookie,
    Depends,
    Header,
    HTTPException,
    Query,
    Request,
    Response,
    status,
)
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..auth import CurrentUser, decode_token
from ..config import AUTH_DEV_MODE, INTERNAL_SERVICE_TOKEN, SESSION_COOKIE_NAME
from ..database import get_db
from ..models import BoardMember, utcnow
from ..permissions import get_active_board
from ..schemas import (
    InternalAccessOut,
    InternalBoardMetadataUpdate,
    InternalRecipientsOut,
)

router = APIRouter(prefix="/internal", tags=["Interno (entre servicios)"])
_bearer = HTTPBearer(auto_error=False)


def _check_service_token(x_service_token: str | None) -> bool:
    if not x_service_token or not INTERNAL_SERVICE_TOKEN:
        return False
    return hmac.compare_digest(
        x_service_token.encode("utf-8"), INTERNAL_SERVICE_TOKEN.encode("utf-8")
    )


def require_service_token(
    x_service_token: str | None = Header(default=None, alias="X-Service-Token"),
) -> None:
    """Exige identidad de servicio mediante X-Service-Token."""
    if _check_service_token(x_service_token):
        return
    raise HTTPException(
        status.HTTP_401_UNAUTHORIZED,
        "Credencial de servicio inválida o ausente",
    )


def resolve_internal_caller(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    cb_session: str | None = Cookie(default=None, alias=SESSION_COOKIE_NAME),
    x_service_token: str | None = Header(default=None, alias="X-Service-Token"),
    x_user_id: str | None = Header(default=None, alias="X-User-Id"),
    query_user_id: str | None = Query(default=None, alias="user_id"),
) -> CurrentUser:
    """Resuelve la identidad del usuario para consultas internas de autorización.

    Regla de seguridad (plan P2, sección 4):
    - Si viene un JWT (Bearer o cookie), la identidad (`user_id`) sale SIEMPRE del token
      firmado por Auth (Go); el llamador no puede sustituir `user_id` mediante cabeceras
      ni parámetros de consulta.
    - Si hay credencial de servicio (`X-Service-Token`), se valida en tiempo constante.
    - Compatibilidad con el cliente interno de Pizarra (Estefan): cuando no envía JWT,
      solo se acepta `X-User-Id`/`?user_id=` si presenta `X-Service-Token` válido o si
      `AUTH_DEV_MODE=true`.
    """
    has_valid_service_token = _check_service_token(x_service_token)
    if x_service_token is not None and not has_valid_service_token:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED,
            "Credencial de servicio inválida",
        )

    if credentials is not None and credentials.credentials:
        return decode_token(credentials.credentials)

    cookie_token = cb_session or request.cookies.get(SESSION_COOKIE_NAME)
    if cookie_token:
        return decode_token(cookie_token)

    delegated_user = (x_user_id or query_user_id or "").strip()
    if delegated_user and (has_valid_service_token or AUTH_DEV_MODE):
        return CurrentUser(id=delegated_user, display_name=delegated_user)

    raise HTTPException(
        status.HTTP_401_UNAUTHORIZED,
        "Se requiere JWT de usuario o credencial de servicio válida",
    )


@router.get("/boards/{board_id}/access", response_model=InternalAccessOut)
def check_board_access(
    board_id: str,
    user: CurrentUser = Depends(resolve_internal_caller),
    db: Session = Depends(get_db),
) -> InternalAccessOut:
    """Devuelve el rol del usuario sobre el tablero o 404 si no existe/fue retirado/inactivo."""
    board = get_active_board(db, board_id)
    if board is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Tablero no encontrado")

    role = db.scalar(
        select(BoardMember.role).where(
            BoardMember.board_id == board_id,
            BoardMember.user_id == user.id,
        )
    )
    if role is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Tablero no encontrado")

    return InternalAccessOut(
        board_id=board.id,
        board_name=board.name,
        owner_id=board.owner_id,
        user_id=user.id,
        role=role,
        exists=True,
        board_status=board.status,
    )


@router.get("/boards/{board_id}/recipients", response_model=InternalRecipientsOut)
def list_board_recipients(
    board_id: str,
    exclude: str | None = Query(default=None, description="ID de usuario a excluir (p. ej. autor)"),
    user: CurrentUser = Depends(resolve_internal_caller),
    db: Session = Depends(get_db),
) -> InternalRecipientsOut:
    """Devuelve los destinatarios autorizados (miembros actuales) excluyendo al actor."""
    board = get_active_board(db, board_id)
    if board is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Tablero no encontrado")

    member_ids = list(
        db.scalars(
            select(BoardMember.user_id)
            .where(BoardMember.board_id == board_id)
            .order_by(BoardMember.joined_at)
        ).all()
    )
    if user.id not in member_ids:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Tablero no encontrado")

    excluded = {user.id}
    if exclude:
        excluded.add(exclude)

    recipients = [uid for uid in member_ids if uid not in excluded]
    return InternalRecipientsOut(
        board_id=board.id,
        board_name=board.name,
        owner_id=board.owner_id,
        recipient_ids=recipients,
    )


@router.patch("/boards/{board_id}/metadata", status_code=status.HTTP_204_NO_CONTENT)
def update_board_metadata(
    board_id: str,
    data: InternalBoardMetadataUpdate,
    x_service_token: str | None = Header(default=None, alias="X-Service-Token"),
    db: Session = Depends(get_db),
) -> Response:
    """Recibe de Pizarra la notificación de que el lienzo se guardó.

    Si el tablero fue eliminado o está en proceso de borrado, devuelve 404 sin
    modificar ni resucitar el registro.
    """
    if x_service_token is not None and not _check_service_token(x_service_token):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Credencial de servicio inválida")

    board = get_active_board(db, board_id)
    if board is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Tablero no encontrado o inactivo")

    now = utcnow()
    saved_at = data.saved_at
    if saved_at is not None and saved_at.tzinfo is None:
        saved_at = saved_at.replace(tzinfo=UTC)

    board.last_saved_at = saved_at or now
    board.updated_at = now
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
