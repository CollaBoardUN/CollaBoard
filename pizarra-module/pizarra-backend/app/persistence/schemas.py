"""JSON que entra y sale de los endpoints de estado y versiones."""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


class _OptionalName(BaseModel):
    name: str | None = Field(default=None, max_length=120)

    @field_validator("name")
    @classmethod
    def strip(cls, v: str | None) -> str | None:
        if v is None:
            return None
        return v.strip() or None  # un nombre vacío equivale a "sin nombre"


class VersionCreate(_OptionalName):
    pass


class VersionRename(_OptionalName):
    pass


class VersionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    number: int
    kind: Literal["auto", "manual", "restore"]
    name: str | None
    created_by: str | None
    created_by_name: str | None
    created_at: datetime
    element_count: int


class VersionDetail(VersionOut):
    """Lo mismo que `VersionOut`, más los elementos (para vista previa o exportar)."""

    elements: list[dict]


class StateOut(BaseModel):
    elements: list[dict]
    seq: int
    saved_at: datetime | None


class RestoreOut(BaseModel):
    restored: VersionOut
    # Copia de seguridad del estado que había antes de restaurar. Si ese estado ya
    # era idéntico a la última versión no se duplica: se devuelve esa versión. Solo
    # es None si el tablero estaba vacío y no había ninguna versión.
    backup: VersionOut | None
    seq: int
