"""Pruebas unitarias de CanvasDB desacoplado de BoardDB (Fase 2 de TASK_PAQUETE_D).

Verifica:
1. Aislamiento total: operaciones sobre board_states y board_versions sin tabla boards.
2. Integridad mediante state_hash y monotonicidad atómica de seq.
3. Endpoint de limpieza DELETE /internal/canvas/boards/{board_id} (idempotente).
4. Bloqueo de autosaves tardíos tras purga (evitando resucitar tableros).
"""

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.persistence.models import BoardState, BoardVersion, PurgedBoard
from app.persistence.store import (
    BoardGone,
    content_hash,
    create_version,
    is_board_purged,
    load_state,
    purge_board,
    save_state,
    state_hash,
)


@pytest.fixture
def canvas_db():
    """Base de datos exclusiva para CanvasDB (solo board_states, board_versions, purged_boards).

    Demuestra estricto aislamiento sin ninguna tabla de BoardDB (boards, board_members, etc.).
    """
    engine = create_engine("sqlite:///:memory:")
    # Creamos únicamente las tablas de CanvasDB
    BoardState.__table__.create(bind=engine)
    BoardVersion.__table__.create(bind=engine)
    PurgedBoard.__table__.create(bind=engine)

    Session = sessionmaker(bind=engine)
    db = Session()
    try:
        yield db
    finally:
        db.close()


def test_canvasdb_isolation_save_and_load(canvas_db):
    """Verifica guardar y cargar sin tablas de BoardDB."""
    board_id = "test-board-uuid-1"
    elements = [{"id": "rect1", "type": "rectangle", "x": 10, "y": 20}]

    saved = save_state(canvas_db, board_id, elements, seq=1)
    assert saved is True

    loaded_elements, seq = load_state(canvas_db, board_id)
    assert loaded_elements == elements
    assert seq == 1

    # Verificación de integridad por state_hash
    state = canvas_db.get(BoardState, board_id)
    assert state.state_hash == state_hash(elements)
    assert state.content_hash == content_hash(elements)


def test_atomic_seq_monotonicity(canvas_db):
    """Verifica que seq avance y nunca retroceda."""
    board_id = "test-board-uuid-seq"
    elements_v1 = [{"id": "elem1", "x": 1}]
    elements_v2 = [{"id": "elem1", "x": 2}]

    save_state(canvas_db, board_id, elements_v1, seq=10)
    save_state(canvas_db, board_id, elements_v2, seq=15)

    _, seq = load_state(canvas_db, board_id)
    assert seq == 15

    # Si llega una operación con seq menor desordenado, se mantiene el más alto
    elements_v3 = [{"id": "elem1", "x": 3}]
    save_state(canvas_db, board_id, elements_v3, seq=12)
    _, seq_after = load_state(canvas_db, board_id)
    assert seq_after == 15


def test_versions_isolated_creation_and_numbering(canvas_db):
    """Verifica creación de versiones y correlación de seq en CanvasDB."""
    board_id = "test-board-versions"
    elements = [{"id": "shape1"}]

    v1 = create_version(canvas_db, board_id, kind="auto", elements=elements, seq=5)
    assert v1.number == 1
    assert v1.seq == 5
    assert v1.state_hash == state_hash(elements)

    v2 = create_version(canvas_db, board_id, kind="manual", elements=elements, seq=6, dedupe=False)
    assert v2.number == 2
    assert v2.seq == 6


def test_purge_board_idempotence_and_blocking(canvas_db):
    """Verifica borrado idempotente y bloqueo estricto de autosave tardío."""
    board_id = "test-board-purge"
    elements = [{"id": "line1"}]

    save_state(canvas_db, board_id, elements, seq=1)
    create_version(canvas_db, board_id, kind="manual", elements=elements, seq=1)

    # 1. Purga
    purge_board(canvas_db, board_id)
    assert is_board_purged(canvas_db, board_id) is True
    assert canvas_db.get(BoardState, board_id) is None
    assert canvas_db.get(PurgedBoard, board_id) is not None

    # 2. Idempotencia: purgar de nuevo no lanza error
    purge_board(canvas_db, board_id)

    # 3. Bloqueo de autosave posterior para no resucitar el tablero
    with pytest.raises(BoardGone):
        save_state(canvas_db, board_id, [{"id": "line2"}], seq=2)

    with pytest.raises(BoardGone):
        create_version(canvas_db, board_id, kind="auto", elements=[], seq=2)


def test_delete_canvas_endpoint(client):
    """Prueba el router DELETE /internal/canvas/boards/{board_id}."""
    resp = client.delete("/internal/canvas/boards/board-to-purge-123")
    assert resp.status_code == 204

    # Idempotencia: segunda llamada también retorna 204
    resp_again = client.delete("/internal/canvas/boards/board-to-purge-123")
    assert resp_again.status_code == 204
