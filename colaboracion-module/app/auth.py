"""ADAPTADOR DE AUTH — el único punto de contacto con el módulo de login.

El servicio de autenticación en Go emite un JWT HS256 con `sub` (id de usuario),
`name`, `email`, `iss` ("collaboard-auth") y `exp`.

Soportamos dos transportes de sesión (plan P2, sección 4):
  1. `Authorization: Bearer <JWT>` (cliente local Electron, BFF de Next.js y llamadas internas).
  2. Cookie HttpOnly `cb_session` (navegador directo / WebSocket). Cuando se autentica por
     cookie en operaciones que modifican estado (POST, PATCH, PUT, DELETE), se valida la
     cabecera `Origin` contra `ALLOWED_ORIGINS` para mitigar CSRF.
"""

from dataclasses import dataclass

import jwt
from fastapi import Cookie, Depends, Header, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from .config import (
    ALLOWED_ORIGINS,
    AUTH_DEV_MODE,
    JWT_ALGORITHM,
    JWT_ISSUER,
    JWT_REQUIRE_EXP,
    JWT_SECRET,
    SESSION_COOKIE_NAME,
)

_bearer = HTTPBearer(auto_error=False)
_SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}


@dataclass
class CurrentUser:
    id: str
    display_name: str | None = None
    via_cookie: bool = False


def decode_token(token: str) -> CurrentUser:
    """Valida el JWT y devuelve el usuario. Sirve también para el WebSocket."""
    options = {"require": ["exp", "sub"]} if JWT_REQUIRE_EXP else {"require": ["sub"]}
    try:
        payload = jwt.decode(
            token,
            JWT_SECRET,
            algorithms=[JWT_ALGORITHM],
            options=options,
        )
    except jwt.ExpiredSignatureError:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "El token expiró") from None
    except jwt.InvalidTokenError:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Token inválido") from None

    # Si el token declara issuer, debe coincidir con el de Auth (Go).
    iss = payload.get("iss")
    if iss is not None and JWT_ISSUER and iss != JWT_ISSUER:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Emisor de token inválido")

    user_id = payload.get("sub")
    if not user_id or not str(user_id).strip():
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "El token no trae 'sub'")
    return CurrentUser(
        id=str(user_id),
        display_name=payload.get("name") or payload.get("email"),
    )


def _validate_cookie_origin(request: Request) -> None:
    """Valida Origin en peticiones mutantes autenticadas mediante cookie."""
    if request.method.upper() in _SAFE_METHODS:
        return
    origin = (request.headers.get("origin") or "").strip().rstrip("/")
    if not origin or origin not in ALLOWED_ORIGINS:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "Origen no permitido para sesión con cookie",
        )


def get_current_user(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    cb_session: str | None = Cookie(default=None, alias=SESSION_COOKIE_NAME),
    x_user_id: str | None = Header(default=None, include_in_schema=AUTH_DEV_MODE),
) -> CurrentUser:
    """Dependencia de FastAPI: devuelve el usuario autenticado o error 401."""
    if credentials is not None and credentials.credentials:
        return decode_token(credentials.credentials)

    cookie_token = cb_session or request.cookies.get(SESSION_COOKIE_NAME)
    if cookie_token:
        _validate_cookie_origin(request)
        user = decode_token(cookie_token)
        user.via_cookie = True
        return user

    # Atajo para desarrollo: sin login, mandando el header "X-User-Id: ana".
    if AUTH_DEV_MODE and x_user_id:
        return CurrentUser(id=x_user_id, display_name=x_user_id)

    raise HTTPException(
        status.HTTP_401_UNAUTHORIZED,
        "No autenticado",
        headers={"WWW-Authenticate": "Bearer"},
    )
