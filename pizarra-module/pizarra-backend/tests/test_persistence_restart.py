"""Prueba de simulación de reinicio de CanvasDB (Sección 4 de TASK_PAQUETE_D).

Valida que tras un reinicio del servicio o desconexión de la base de datos:
1. El contador incremental seq no se reinicie a cero ni retroceda.
2. Las versiones y su contenido con state_hash se preserven íntegros.
3. Se pueda reanudar el guardado incremental a partir del último seq guardado.
"""

import tempfile

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.persistence.models import BoardState, BoardVersion, PurgedBoard
from app.persistence.store import (
    create_version,
    get_version,
    list_versions,
    load_state,
    save_state,
    state_hash,
)


def test_canvasdb_persistence_across_restart():
    # Usamos archivo SQLite en disco para simular persistencia en BD real
    with tempfile.NamedTemporaryFile(suffix=".db") as db_file:
        db_url = f"sqlite:///{db_file.name}"

        # --- PASO 1: Arrancar sesión previa al reinicio ---
        engine1 = create_engine(db_url)
        BoardState.__table__.create(bind=engine1)
        BoardVersion.__table__.create(bind=engine1)
        PurgedBoard.__table__.create(bind=engine1)

        Session1 = sessionmaker(bind=engine1)
        board_id = "board-restart-test"
        elements_initial = [{"id": "rect1", "x": 10, "y": 20}]

        with Session1() as db1:
            # Guardamos estado inicial con seq = 42
            saved = save_state(db1, board_id, elements_initial, seq=42)
            assert saved is True

            # Creamos dos versiones manuales
            v1 = create_version(
                db1, board_id, kind="manual", elements=elements_initial, seq=42, name="Hito 1"
            )
            assert v1.number == 1
            assert v1.seq == 42
            v1_id = v1.id

            elements_v2 = [{"id": "rect1", "x": 10, "y": 20}, {"id": "circle2", "x": 50, "y": 60}]
            save_state(db1, board_id, elements_v2, seq=55)
            v2 = create_version(
                db1, board_id, kind="manual", elements=elements_v2, seq=55, name="Hito 2"
            )
            assert v2.number == 2
            assert v2.seq == 55

        # --- PASO 2: Simulación de reinicio forzado del servidor y pool de base de datos ---
        engine1.dispose()  # Cierra todas las conexiones activas y limpia memoria

        # --- PASO 3: Nuevo proceso / reconexión tras reinicio ---
        engine2 = create_engine(db_url)
        Session2 = sessionmaker(bind=engine2)

        with Session2() as db2:
            # 1. Cargar estado tras reinicio: debe conservar exactamente seq=55 y los elementos
            loaded_elements, seq_after_restart = load_state(db2, board_id)
            assert seq_after_restart == 55
            assert loaded_elements == elements_v2
            assert state_hash(loaded_elements) == state_hash(elements_v2)

            # 2. Las versiones deben seguir intactas
            versions = list_versions(db2, board_id)
            assert len(versions) == 2
            assert versions[0].number == 2
            assert versions[0].seq == 55
            assert versions[1].number == 1
            assert versions[1].seq == 42

            # 3. Validar contenido desglosado de una versión
            v1_reloaded = get_version(db2, board_id, v1_id, with_elements=True)
            assert v1_reloaded is not None
            assert v1_reloaded.elements == elements_initial
            assert v1_reloaded.state_hash == state_hash(elements_initial)

            # 4. Reanudar operaciones: el seq continúa avanzando sin reiniciar
            elements_v3 = [
                {"id": "rect1", "x": 10, "y": 20},
                {"id": "circle2", "x": 50, "y": 60},
                {"id": "line3"},
            ]
            save_state(db2, board_id, elements_v3, seq=56)
            _, final_seq = load_state(db2, board_id)
            assert final_seq == 56

        engine2.dispose()
