"""Inicialización de CanvasDB: board_states, board_versions y purged_boards.

Revision ID: 0001_canvasdb_init
Revises:
Create Date: 2026-10-27
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0001_canvasdb_init"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _json() -> sa.types.TypeEngine:
    return sa.JSON().with_variant(postgresql.JSONB(), "postgresql")


def upgrade() -> None:
    op.create_table(
        "board_states",
        sa.Column("board_id", sa.String(length=36), nullable=False),
        sa.Column("elements", _json(), nullable=False),
        sa.Column("seq", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("element_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("state_hash", sa.String(length=64), nullable=False),
        sa.Column("thumbnail_svg", sa.Text(), nullable=True),
        sa.Column("thumbnail_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("saved_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("is_deleted", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.PrimaryKeyConstraint("board_id"),
    )
    op.create_index("ix_board_states_board_id", "board_states", ["board_id"])

    op.create_table(
        "board_versions",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("board_id", sa.String(length=36), nullable=False),
        sa.Column("number", sa.Integer(), nullable=False),
        sa.Column("kind", sa.String(length=16), nullable=False),
        sa.Column("name", sa.String(length=120), nullable=True),
        sa.Column("created_by", sa.String(length=64), nullable=True),
        sa.Column("created_by_name", sa.String(length=120), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("seq", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("element_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("state_hash", sa.String(length=64), nullable=False),
        sa.Column("elements", _json(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("board_id", "number", name="uq_board_version_number"),
    )
    op.create_index(
        "ix_board_versions_board_created", "board_versions", ["board_id", "created_at"]
    )
    op.create_index(
        "ix_board_versions_board_id", "board_versions", ["board_id"]
    )

    op.create_table(
        "purged_boards",
        sa.Column("board_id", sa.String(length=36), nullable=False),
        sa.Column("purged_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("board_id"),
    )


def downgrade() -> None:
    op.drop_table("purged_boards")
    op.drop_index("ix_board_versions_board_id", table_name="board_versions")
    op.drop_index("ix_board_versions_board_created", table_name="board_versions")
    op.drop_table("board_versions")
    op.drop_index("ix_board_states_board_id", table_name="board_states")
    op.drop_table("board_states")
