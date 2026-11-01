"""Modelos de CanvasDB: estado actual de cada tablero e historial de versiones.

Completamente desacoplado de BoardDB (sin Foreign Keys ni relaciones directas a boards).
Almacenamiento nativo en PostgreSQL usando JSONB para snapshots y elementos del canvas.
"""

import uuid
from datetime import UTC, datetime

from sqlalchemy import Boolean, DateTime, Index, Integer, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.types import JSON

from ..database import Base

# JSONB en PostgreSQL; JSON genérico en SQLite (los tests).
JsonType = JSON().with_variant(JSONB(), "postgresql")

VERSION_KINDS = ("auto", "manual", "restore")


def _utcnow() -> datetime:
    return datetime.now(UTC)


def _new_id() -> str:
    return str(uuid.uuid4())


class BoardState(Base):
    __tablename__ = "board_states"

    board_id: Mapped[str] = mapped_column(String(36), primary_key=True, index=True)
    elements: Mapped[list] = mapped_column(JsonType, default=list)
    # Último `seq` de la sala al guardar (para garantizar incremento y continuidad).
    seq: Mapped[int] = mapped_column(Integer, default=0)
    element_count: Mapped[int] = mapped_column(Integer, default=0)
    # SHA-256 del JSON canónico para integridad y control de cambios.
    state_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    thumbnail_svg: Mapped[str | None] = mapped_column(Text, nullable=True)
    thumbnail_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    saved_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)
    is_deleted: Mapped[bool] = mapped_column(Boolean, default=False)

    @property
    def content_hash(self) -> str:
        return self.state_hash

    @content_hash.setter
    def content_hash(self, value: str) -> None:
        self.state_hash = value


class BoardVersion(Base):
    __tablename__ = "board_versions"
    __table_args__ = (
        UniqueConstraint("board_id", "number", name="uq_board_version_number"),
        Index("ix_board_versions_board_created", "board_id", "created_at"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_new_id)
    board_id: Mapped[str] = mapped_column(String(36), index=True, nullable=False)
    # Numeración por tablero: v1, v2, v3…
    number: Mapped[int] = mapped_column(Integer, nullable=False)
    kind: Mapped[str] = mapped_column(String(16), nullable=False)
    name: Mapped[str | None] = mapped_column(String(120), nullable=True)
    created_by: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_by_name: Mapped[str | None] = mapped_column(String(120), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)
    seq: Mapped[int] = mapped_column(Integer, default=0)
    element_count: Mapped[int] = mapped_column(Integer, default=0)
    state_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    # `deferred`: al listar no se cargan los JSON pesados
    elements: Mapped[list] = mapped_column(JsonType, deferred=True)

    @property
    def content_hash(self) -> str:
        return self.state_hash

    @content_hash.setter
    def content_hash(self, value: str) -> None:
        self.state_hash = value


class PurgedBoard(Base):
    """Registro de tableros purgados para bloquear autosaves tardíos en CanvasDB."""

    __tablename__ = "purged_boards"

    board_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    purged_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)
