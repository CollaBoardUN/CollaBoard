"""Revisión histórica P1; CanvasDB se migra desde Pizarra en P2.

Se conserva el identificador para reconocer instalaciones previas. Los datos
históricos se copian con scripts/migrate_p1_to_canvasdb.py antes del cambio.
"""
revision = "0002_persistencia"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade():
    pass


def downgrade():
    pass
