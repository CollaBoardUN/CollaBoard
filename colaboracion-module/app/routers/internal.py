"""Endpoints internos de Colaboración (/internal/*) — Policy Decision Point (PDP).

Consumidos por los PEPs de Pizarra y Chat en la red interna de contenedores. El API
Gateway bloquea cualquier solicitud externa a `/internal/*`.

Rutas:
  GET   /internal/boards/{board_id}/access      decisión PDP: rol, permisos y acción permitida
  GET   /internal/boards/{board_id}/recipients  destinatarios autorizados (excluye autor)
  PATCH /internal/boards/{board_id}/metadata    callback de guardado de Pizarra
  GET   /internal/policy                        tabla completa de política RBAC (rol × acción)
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
from ..config import (
    AUTH_DEV_MODE,
    AUTHZ_DECISION_TTL_SECONDS,
    INTERNAL_SERVICE_TOKEN,
    SESSION_COOKIE_NAME,
)
from ..database import get_db
from ..models import BoardMember, utcnow
from ..permissions import get_active_board
from ..policy import (
    Action,
    is_action_allowed,
    permissions_for_role,
    policy_as_dict,
)
from ..schemas import (
    InternalAccessOut,
    InternalBoardMetadataUpdate,
    InternalRecipientsOut,
)

router = APIRouter(prefix="/internal", tags=["Interno (PDP entre servicios)"])
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

    Regla de seguridad:
    - Si viene un JWT (Bearer o cookie), la identidad (`user_id`) sale SIEMPRE del token
      firmado por Auth (Go); el llamador no puede sustituir `user_id` mediante cabeceras
      ni parámetros de consulta.
    - Si hay credencial de servicio (`X-Service-Token`), se valida en tiempo constante.
    - Cuando no se envía JWT, solo se acepta `X-User-Id`/`?user_id=` si presenta
      `X-Service-Token` válido o si `AUTH_DEV_MODE=true`.
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


@router.get("/policy")
def get_rbac_policy(
    _: None = Depends(require_service_token),
) -> dict[str, object]:
    """Exporta la tabla declarativa de política RBAC del PDP."""
    return {
        "pdp": "collaboration-api",
        "cache_ttl_seconds": AUTHZ_DECISION_TTL_SECONDS,
        "actions": policy_as_dict(),
    }


@router.get("/boards/{board_id}/access", response_model=InternalAccessOut)
def check_board_access(
    board_id: str,
    action: str | None = Query(
        default=None,
        description="Acción RBAC a evaluar en el PDP (p. ej. canvas:edit, chat:send)",
    ),
    user: CurrentUser = Depends(resolve_internal_caller),
    db: Session = Depends(get_db),
) -> InternalAccessOut:
    """Policy Decision Point (PDP): evalúa membresía, rol y acción sobre un tablero.

    - 404 si el tablero no existe, está inactivo o el usuario no es miembro (no filtra existencia).
    - 422 si se solicita una `action` que no existe en la tabla de política `POLICY_MATRIX`.
    - 200 con `role`, `permissions`, `action`, `allowed` (True/False según `POLICY_MATRIX`)
      y `cache_ttl_seconds`.
    """
    if action is not None:
        try:
            Action(action)
        except ValueError:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                f"Acción RBAC desconocida: '{action}'",
            ) from None

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

    granted = permissions_for_role(role)
    allowed = True if action is None else is_action_allowed(role, action)

    return InternalAccessOut(
        board_id=board.id,
        board_name=board.name,
        owner_id=board.owner_id,
        user_id=user.id,
        role=role,
        exists=True,
        board_status=board.status,
        action=action,
        allowed=allowed,
        permissions=granted,
        cache_ttl_seconds=AUTHZ_DECISION_TTL_SECONDS,
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
