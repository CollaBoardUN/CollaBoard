"""Tablas del dominio de Colaboración (BoardDB): tableros, miembros, invitaciones y outbox.

La tabla de usuarios NO está aquí: pertenece a UserDB (authentication-module en Go).
El estado e historial del lienzo NO está aquí: pertenece a CanvasDB (pizarra-module).
Guardamos solo referencias externas (user_id) como texto.
"""

import enum
import secrets
import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    Enum,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects import postgresql
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .database import Base


def utcnow() -> datetime:
    return datetime.now(UTC)


def new_id() -> str:
    return str(uuid.uuid4())


def new_token() -> str:
    # 32 bytes aleatorios -> imposible de adivinar
    return secrets.token_urlsafe(32)


def _json_type():
    return JSON().with_variant(postgresql.JSONB(), "postgresql")


class Role(enum.StrEnum):
    viewer = "viewer"  # solo mira y conversa en chat
    editor = "editor"  # mira, dibuja y usa historial
    owner = "owner"  # todo: renombrar, borrar, compartir, gestionar miembros


# Jerarquía: un rol "alcanza" a otro si su número es mayor o igual.
ROLE_RANK = {Role.viewer: 1, Role.editor: 2, Role.owner: 3}


class BoardStatus(enum.StrEnum):
    active = "active"
    deleting = "deleting"
    deleted = "deleted"


class OutboxStatus(enum.StrEnum):
    pending = "pending"
    sent = "sent"
    failed = "failed"


class Board(Base):
    __tablename__ = "boards"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(String(120))
    owner_id: Mapped[str] = mapped_column(String(64), index=True)
    status: Mapped[str] = mapped_column(
        String(16), default=BoardStatus.active.value, server_default="active", index=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow
    )
    last_saved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    # Al borrar físicamente un tablero se borran sus miembros e invitaciones.
    members: Mapped[list["BoardMember"]] = relationship(
        back_populates="board", cascade="all, delete-orphan"
    )
    invites: Mapped[list["Invite"]] = relationship(
        back_populates="board", cascade="all, delete-orphan"
    )

    @property
    def is_active(self) -> bool:
        return self.status == BoardStatus.active.value


class BoardMember(Base):
    __tablename__ = "board_members"
    __table_args__ = (UniqueConstraint("board_id", "user_id", name="uq_board_user"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    board_id: Mapped[str] = mapped_column(ForeignKey("boards.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[str] = mapped_column(String(64), index=True)
    # Nombre o correo tomado del token al unirse, para mostrarlo en la lista.
    display_name: Mapped[str | None] = mapped_column(String(120), nullable=True)
    role: Mapped[Role] = mapped_column(Enum(Role, name="board_role"))
    joined_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    board: Mapped[Board] = relationship(back_populates="members")


class Invite(Base):
    __tablename__ = "board_invites"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    token: Mapped[str] = mapped_column(String(64), unique=True, index=True, default=new_token)
    board_id: Mapped[str] = mapped_column(ForeignKey("boards.id", ondelete="CASCADE"), index=True)
    role: Mapped[Role] = mapped_column(Enum(Role, name="board_role"))
    created_by: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    revoked: Mapped[bool] = mapped_column(Boolean, default=False)
    uses: Mapped[int] = mapped_column(Integer, default=0)

    board: Mapped[Board] = relationship(back_populates="invites")


class OutboxEvent(Base):
    """Outbox transaccional de Colaboración.

    Persiste en la misma transacción SQL tanto eventos hacia NotificationAPI
    (`kind="notification.event"`, p. ej. `invite.accepted`) como tareas de limpieza
    idempotente al borrar un tablero (`kind="cleanup.canvas"`, `kind="cleanup.chat"`).
    El mismo `event_id` se conserva en todos los reintentos.
    """

    __tablename__ = "outbox_events"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    event_id: Mapped[str] = mapped_column(String(64), unique=True, index=True, default=new_id)
    kind: Mapped[str] = mapped_column(String(40), index=True)
    board_id: Mapped[str] = mapped_column(String(36), index=True)
    method: Mapped[str] = mapped_column(String(10), default="POST")
    target_url: Mapped[str] = mapped_column(String(255))
    payload: Mapped[dict[str, Any] | None] = mapped_column(_json_type(), nullable=True)
    status: Mapped[str] = mapped_column(
        String(16), default=OutboxStatus.pending.value, server_default="pending", index=True
    )
    attempts: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    next_attempt_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, index=True
    )
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
