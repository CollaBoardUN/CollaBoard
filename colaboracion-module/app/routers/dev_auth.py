"""Login FALSO para desarrollo — solo existe si AUTH_DEV_MODE=true.

Permite usar y probar el frontend mientras el módulo de auth real no está
listo: emite un JWT firmado con la misma clave y formato ("sub", "name", "iss", "exp")
que usa el módulo de autenticación en Go. Cuando el login real está activo, se pone
AUTH_DEV_MODE=false y este endpoint desaparece.
"""

from datetime import UTC, datetime, timedelta

import jwt
from fastapi import APIRouter
from pydantic import BaseModel, Field

from ..config import JWT_ALGORITHM, JWT_ISSUER, JWT_SECRET

router = APIRouter(prefix="/dev", tags=["Solo desarrollo"])


class DevLogin(BaseModel):
    user_id: str = Field(min_length=1, max_length=64, examples=["ana"])
    name: str | None = Field(default=None, max_length=120, examples=["Ana"])


class TokenOut(BaseModel):
    access_token: str
    token_type: str = "bearer"


@router.post("/token", response_model=TokenOut)
def dev_token(data: DevLogin):
    payload = {
        "sub": data.user_id,
        "name": data.name or data.user_id,
        "iss": JWT_ISSUER,
        "exp": datetime.now(UTC) + timedelta(days=7),
    }
    return TokenOut(access_token=jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM))
