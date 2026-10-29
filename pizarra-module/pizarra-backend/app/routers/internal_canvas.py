"""Router de endpoints internos para CanvasDB.

DELETE /internal/canvas/boards/{board_id}
Purga el canvas y versiones de forma idempotente y bloquea autosaves tardíos.
"""

import logging

from fastapi import APIRouter, Depends, Response, status
from sqlalchemy.orm import Session

from ..database import get_db
from ..persistence.autosave import autosaver
from ..persistence.store import purge_board

log = logging.getLogger(__name__)

router = APIRouter(prefix="/internal/canvas", tags=["Canvas Interno"])


@router.delete("/boards/{board_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_canvas_board(board_id: str, db: Session = Depends(get_db)) -> Response:
    """Purga de forma idempotente el estado del canvas y sus versiones en CanvasDB.

    - Bloquea inmediatamente cualquier autosave tardío para evitar resucitar el tablero.
    - Elimina filas de board_states y board_versions en CanvasDB.
    - Registra la purga en purged_boards para persistir el bloqueo.
    - Retorna 204 No Content.
    """
    # 1. Bloqueo en memoria y cancelación de tareas pendientes de autosave
    autosaver.mark_purged(board_id)

    # 2. Purga y registro persistente en CanvasDB
    purge_board(db, board_id)
    log.info("Canvas del tablero %s purgado exitosamente de CanvasDB", board_id)

    return Response(status_code=status.HTTP_204_NO_CONTENT)
