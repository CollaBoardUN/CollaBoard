"""Tablas de la Persona 4: estado actual de cada tablero y sus versiones.

- `board_states`: UNA fila por tablero con los elementos actuales (lo que el
  autosave mantiene al día y lo que se carga cuando alguien se une).
- `board_versions`: historial. Cada fila es una foto completa del tablero.

Los elementos se guardan como una lista JSON con el mismo formato que viaja por
el WebSocket (`CanvasElement`). El orden de la lista es el z-order.
"""

import uuid
from datetime import UTC, datetime

from sqlalchemy import JSON, DateTime, ForeignKey, Index, Integer, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

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

    board_id: Mapped[str] = mapped_column(
        ForeignKey("boards.id", ondelete="CASCADE"), primary_key=True
    )
    elements: Mapped[list] = mapped_column(JsonType, default=list)
    # Último `seq` de la sala al guardar (para que siga creciendo tras un reinicio).
    seq: Mapped[int] = mapped_column(Integer, default=0)
    element_count: Mapped[int] = mapped_column(Integer, default=0)
    # SHA-256 del JSON canónico: sirve para no guardar ni versionar lo que no cambió.
    content_hash: Mapped[str] = mapped_column(String(64))
    thumbnail_svg: Mapped[str | None] = mapped_column(Text, nullable=True)
    thumbnail_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    saved_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)

    board = relationship("Board", back_populates="state")


class BoardVersion(Base):
    __tablename__ = "board_versions"
    __table_args__ = (
        UniqueConstraint("board_id", "number", name="uq_board_version_number"),
        Index("ix_board_versions_board_created", "board_id", "created_at"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_new_id)
    board_id: Mapped[str] = mapped_column(ForeignKey("boards.id", ondelete="CASCADE"))
    # Numeración por tablero: v1, v2, v3… (es lo que ve el usuario).
    number: Mapped[int] = mapped_column(Integer)
    # "auto" (periódica), "manual" (la pidió una persona) o "restore" (copia de
    # seguridad previa a restaurar otra versión).
    kind: Mapped[str] = mapped_column(String(16))
    name: Mapped[str | None] = mapped_column(String(120), nullable=True)
    created_by: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_by_name: Mapped[str | None] = mapped_column(String(120), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)
    seq: Mapped[int] = mapped_column(Integer, default=0)
    element_count: Mapped[int] = mapped_column(Integer, default=0)
    content_hash: Mapped[str] = mapped_column(String(64))
    # `deferred`: al listar o al borrar un tablero no se cargan los JSON pesados.
    elements: Mapped[list] = mapped_column(JsonType, deferred=True)

    board = relationship("Board", back_populates="versions")
