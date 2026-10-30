"""Ciclo de vida de tableros y outbox transaccional (Prototipo 2).

Revision ID: 0002_ciclo_de_vida_y_outbox
Revises: 0001
Create Date: 2026-10-30
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0002_ciclo_de_vida_y_outbox"
down_revision: str | None = "0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _json() -> sa.types.TypeEngine:
    return sa.JSON().with_variant(postgresql.JSONB(), "postgresql")


def upgrade() -> None:
    op.add_column(
        "boards",
        sa.Column("status", sa.String(length=16), nullable=False, server_default="active"),
    )
    op.add_column(
        "boards",
        sa.Column("last_saved_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "boards",
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_boards_status", "boards", ["status"])

    op.create_table(
        "outbox_events",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("event_id", sa.String(length=64), nullable=False),
        sa.Column("kind", sa.String(length=40), nullable=False),
        sa.Column("board_id", sa.String(length=36), nullable=False),
        sa.Column("method", sa.String(length=10), nullable=False, server_default="POST"),
        sa.Column("target_url", sa.String(length=255), nullable=False),
        sa.Column("payload", _json(), nullable=True),
        sa.Column("status", sa.String(length=16), nullable=False, server_default="pending"),
        sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("next_attempt_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_error", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("sent_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_outbox_events_event_id", "outbox_events", ["event_id"], unique=True)
    op.create_index("ix_outbox_events_kind", "outbox_events", ["kind"])
    op.create_index("ix_outbox_events_board_id", "outbox_events", ["board_id"])
    op.create_index("ix_outbox_events_status", "outbox_events", ["status"])
    op.create_index("ix_outbox_events_next_attempt_at", "outbox_events", ["next_attempt_at"])


def downgrade() -> None:
    op.drop_index("ix_outbox_events_next_attempt_at", table_name="outbox_events")
    op.drop_index("ix_outbox_events_status", table_name="outbox_events")
    op.drop_index("ix_outbox_events_board_id", table_name="outbox_events")
    op.drop_index("ix_outbox_events_kind", table_name="outbox_events")
    op.drop_index("ix_outbox_events_event_id", table_name="outbox_events")
    op.drop_table("outbox_events")

    op.drop_index("ix_boards_status", table_name="boards")
    op.drop_column("boards", "deleted_at")
    op.drop_column("boards", "last_saved_at")
    op.drop_column("boards", "status")
