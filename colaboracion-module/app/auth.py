"""ADAPTADOR DE AUTH — el único punto de contacto con el módulo de login.

Tu compañero de auth se encarga del registro, login y de emitir el token JWT.
Aquí solo LEEMOS ese token para saber quién hace la petición.

Lo que hay que acordar con él (y cambiar aquí si es distinto):
  1. La clave secreta y el algoritmo (JWT_SECRET / JWT_ALGORITHM en .env).
  2. En qué campo del token viene el id del usuario. Aquí asumimos "sub",
     que es el estándar.
  3. (Opcional) Si el token trae "name" o "email", lo usamos para mostrar
     el nombre en la lista de miembros.

Si tu compañero ya tiene su propia función `get_current_user`, puedes
borrar la de aquí e importar la suya: lo único que necesitan los demás
archivos es un objeto con `.id` y `.display_name`.
"""

from dataclasses import dataclass

import jwt
from fastapi import Depends, Header, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from .config import AUTH_DEV_MODE, JWT_ALGORITHM, JWT_SECRET

_bearer = HTTPBearer(auto_error=False)


@dataclass
class CurrentUser:
    id: str
    display_name: str | None = None


def decode_token(token: str) -> CurrentUser:
    """Valida el JWT y devuelve el usuario. Sirve también para el WebSocket."""
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
    except jwt.ExpiredSignatureError:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "El token expiró") from None
    except jwt.InvalidTokenError:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Token inválido") from None

    user_id = payload.get("sub")
    if not user_id:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "El token no trae 'sub'")
    return CurrentUser(
        id=str(user_id),
        display_name=payload.get("name") or payload.get("email"),
    )


def get_current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    x_user_id: str | None = Header(default=None, include_in_schema=AUTH_DEV_MODE),
) -> CurrentUser:
    """Dependencia de FastAPI: devuelve el usuario autenticado o error 401."""
    if credentials is not None:
        return decode_token(credentials.credentials)

    # Atajo para desarrollo: sin login, mandando el header "X-User-Id: ana".
    if AUTH_DEV_MODE and x_user_id:
        return CurrentUser(id=x_user_id, display_name=x_user_id)

    raise HTTPException(
        status.HTTP_401_UNAUTHORIZED,
        "No autenticado",
        headers={"WWW-Authenticate": "Bearer"},
    )
