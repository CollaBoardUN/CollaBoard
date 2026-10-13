"""Tablas de la Persona 1: tableros, miembros e invitaciones.

La tabla de usuarios NO está aquí: es del módulo de auth. Guardamos solo el
id del usuario (user_id) como texto, que es lo que viene dentro del token JWT.
"""

import enum
import secrets
import uuid
from datetime import UTC, datetime

from sqlalchemy import (
    Boolean,
    DateTime,
    Enum,
    ForeignKey,
    Integer,
    String,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .database import Base


def utcnow() -> datetime:
    return datetime.now(UTC)


def new_id() -> str:
    return str(uuid.uuid4())


def new_token() -> str:
    # 32 bytes aleatorios -> imposible de adivinar
    return secrets.token_urlsafe(32)


class Role(enum.StrEnum):
    viewer = "viewer"  # solo mira
    editor = "editor"  # mira y dibuja
    owner = "owner"  # todo: renombrar, borrar, compartir, gestionar miembros


# Jerarquía: un rol "alcanza" a otro si su número es mayor o igual.
ROLE_RANK = {Role.viewer: 1, Role.editor: 2, Role.owner: 3}


class Board(Base):
    __tablename__ = "boards"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(String(120))
    owner_id: Mapped[str] = mapped_column(String(64), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow
    )

    # Al borrar un tablero se borran sus miembros e invitaciones.
    members: Mapped[list["BoardMember"]] = relationship(
        back_populates="board", cascade="all, delete-orphan"
    )
    invites: Mapped[list["Invite"]] = relationship(
        back_populates="board", cascade="all, delete-orphan"
    )
    # Persistencia (Persona 4): estado actual e historial. Se borran con el tablero.
    state: Mapped["BoardState | None"] = relationship(
        back_populates="board", cascade="all, delete-orphan", uselist=False
    )
    versions: Mapped[list["BoardVersion"]] = relationship(
        back_populates="board", cascade="all, delete-orphan"
    )


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


# Registra las tablas de persistencia (Persona 4) para Alembic y create_all.
from .persistence.models import BoardState, BoardVersion  # noqa: E402,F401
