"""Esquemas Pydantic: definen qué JSON entra y qué JSON sale de la API."""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from .models import Role

# Roles que se pueden dar por invitación o al cambiar un miembro.
# "owner" no se regala: siempre hay exactamente un dueño.
ShareableRole = Literal["editor", "viewer"]


class _Name(BaseModel):
    name: str = Field(min_length=1, max_length=120)

    @field_validator("name")
    @classmethod
    def strip(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("El nombre no puede estar vacío")
        return v


class BoardCreate(_Name):
    pass


class BoardUpdate(_Name):
    pass


class BoardOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    name: str
    owner_id: str
    my_role: Role
    member_count: int
    created_at: datetime
    updated_at: datetime


class MemberOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    user_id: str
    display_name: str | None
    role: Role
    joined_at: datetime


class MemberRoleUpdate(BaseModel):
    role: ShareableRole


class InviteCreate(BaseModel):
    role: ShareableRole = "editor"
    # Horas hasta que el link deje de funcionar. None = no expira.
    expires_in_hours: int | None = Field(default=168, ge=1, le=24 * 30)


class InviteOut(BaseModel):
    id: str
    token: str
    url: str
    role: Role
    created_at: datetime
    expires_at: datetime | None
    uses: int


class InvitePreview(BaseModel):
    board_id: str
    board_name: str
    role: Role
    already_member: bool
    current_role: Role | None


class JoinResult(BaseModel):
    board_id: str
    role: Role


# ---------------------------------------------------------------- contratos internos


class InternalAccessOut(BaseModel):
    """Respuesta de GET /internal/boards/{board_id}/access."""

    board_id: str
    board_name: str
    owner_id: str
    user_id: str
    role: Role
    exists: bool = True
    board_status: str = "active"


class InternalRecipientsOut(BaseModel):
    """Respuesta de GET /internal/boards/{board_id}/recipients."""

    board_id: str
    board_name: str
    owner_id: str
    recipient_ids: list[str]


class InternalBoardMetadataUpdate(BaseModel):
    """Callback de Pizarra tras persistir el estado del lienzo."""

    element_count: int | None = Field(default=None, ge=0)
    seq: int | None = Field(default=None, ge=0)
    state_hash: str | None = Field(default=None, max_length=128)
    saved_at: datetime | None = None
