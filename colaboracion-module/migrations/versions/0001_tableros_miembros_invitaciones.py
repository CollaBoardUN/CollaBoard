"""Tableros, miembros e invitaciones (Persona 1).

Revision ID: 0001
Revises:
Create Date: 2026-10-11
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0001"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

ROLES = ("viewer", "editor", "owner")


def _role_type(bind) -> sa.types.TypeEngine:
    # En PostgreSQL el tipo ENUM se crea una sola vez y lo comparten dos tablas.
    if bind.dialect.name == "postgresql":
        return postgresql.ENUM(*ROLES, name="board_role", create_type=False)
    return sa.Enum(*ROLES, name="board_role")


def upgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name == "postgresql":
        postgresql.ENUM(*ROLES, name="board_role").create(bind, checkfirst=True)
    role = _role_type(bind)

    op.create_table(
        "boards",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("owner_id", sa.String(length=64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_boards_owner_id", "boards", ["owner_id"])

    op.create_table(
        "board_invites",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("token", sa.String(length=64), nullable=False),
        sa.Column("board_id", sa.String(length=36), nullable=False),
        sa.Column("role", role, nullable=False),
        sa.Column("created_by", sa.String(length=64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("revoked", sa.Boolean(), nullable=False),
        sa.Column("uses", sa.Integer(), nullable=False),
        sa.ForeignKeyConstraint(["board_id"], ["boards.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_board_invites_board_id", "board_invites", ["board_id"])
    op.create_index("ix_board_invites_token", "board_invites", ["token"], unique=True)

    op.create_table(
        "board_members",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("board_id", sa.String(length=36), nullable=False),
        sa.Column("user_id", sa.String(length=64), nullable=False),
        sa.Column("display_name", sa.String(length=120), nullable=True),
        sa.Column("role", role, nullable=False),
        sa.Column("joined_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["board_id"], ["boards.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("board_id", "user_id", name="uq_board_user"),
    )
    op.create_index("ix_board_members_board_id", "board_members", ["board_id"])
    op.create_index("ix_board_members_user_id", "board_members", ["user_id"])


def downgrade() -> None:
    op.drop_index("ix_board_members_user_id", table_name="board_members")
    op.drop_index("ix_board_members_board_id", table_name="board_members")
    op.drop_table("board_members")
    op.drop_index("ix_board_invites_token", table_name="board_invites")
    op.drop_index("ix_board_invites_board_id", table_name="board_invites")
    op.drop_table("board_invites")
    op.drop_index("ix_boards_owner_id", table_name="boards")
    op.drop_table("boards")
    bind = op.get_bind()
    if bind.dialect.name == "postgresql":
        postgresql.ENUM(name="board_role").drop(bind, checkfirst=True)
