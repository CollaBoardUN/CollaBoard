"""Estado guardado e historial de versiones de un tablero.

GET    /boards/{id}/state                       estado actual                 (viewer+)
GET    /boards/{id}/versions                    lista (sin elementos)         (viewer+)
GET    /boards/{id}/versions/{vid}              una versión con elementos     (viewer+)
POST   /boards/{id}/versions                    crear versión manual          (editor+)
PATCH  /boards/{id}/versions/{vid}              renombrar                     (editor+)
POST   /boards/{id}/versions/{vid}/restore      restaurar                     (editor+)
DELETE /boards/{id}/versions/{vid}              borrar                        (owner)
"""

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import Role
from ..permissions import BoardAccess, require_role
from ..persistence import service
from ..persistence.schemas import (
    RestoreOut,
    StateOut,
    VersionCreate,
    VersionDetail,
    VersionOut,
    VersionRename,
)
from ..persistence.store import (
    BoardGone,
    TooManyVersions,
    get_version,
    list_versions,
)

router = APIRouter(prefix="/boards/{board_id}", tags=["Versiones"])

NOT_FOUND = "Versión no encontrada"


@router.get("/state", response_model=StateOut)
async def get_state(access: BoardAccess = Depends(require_role(Role.viewer))):
    elements, seq, saved_at = await service.current_state(access.board.id)
    return StateOut(elements=elements, seq=seq, saved_at=saved_at)


@router.get("/versions", response_model=list[VersionOut])
def list_board_versions(
    limit: int = Query(default=50, ge=1, le=100),
    access: BoardAccess = Depends(require_role(Role.viewer)),
    db: Session = Depends(get_db),
):
    return list_versions(db, access.board.id, limit)


@router.get("/versions/{version_id}", response_model=VersionDetail)
def read_version(
    version_id: str,
    access: BoardAccess = Depends(require_role(Role.viewer)),
    db: Session = Depends(get_db),
):
    version = get_version(db, access.board.id, version_id, with_elements=True)
    if version is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, NOT_FOUND)
    return version


@router.post("/versions", response_model=VersionOut, status_code=status.HTTP_201_CREATED)
async def create_board_version(
    data: VersionCreate | None = None,
    access: BoardAccess = Depends(require_role(Role.editor)),
):
    try:
        name = data.name if data else None
        return await service.create_manual_version(access.board.id, access.user, name)
    except TooManyVersions:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "Llegaste al máximo de versiones guardadas. Borra alguna para crear otra.",
        ) from None
    except BoardGone:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Tablero no encontrado") from None


@router.patch("/versions/{version_id}", response_model=VersionOut)
def rename_version(
    version_id: str,
    data: VersionRename,
    access: BoardAccess = Depends(require_role(Role.editor)),
    db: Session = Depends(get_db),
):
    version = get_version(db, access.board.id, version_id)
    if version is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, NOT_FOUND)
    version.name = data.name
    db.commit()
    return version


@router.post("/versions/{version_id}/restore", response_model=RestoreOut)
async def restore_board_version(
    version_id: str,
    access: BoardAccess = Depends(require_role(Role.editor)),
):
    try:
        restored, backup, seq = await service.restore_version(
            access.board.id, version_id, access.user
        )
    except service.VersionNotFound:
        raise HTTPException(status.HTTP_404_NOT_FOUND, NOT_FOUND) from None
    except BoardGone:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Tablero no encontrado") from None
    return RestoreOut(restored=restored, backup=backup, seq=seq)


@router.delete("/versions/{version_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_version(
    version_id: str,
    access: BoardAccess = Depends(require_role(Role.owner)),
    db: Session = Depends(get_db),
):
    version = get_version(db, access.board.id, version_id)
    if version is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, NOT_FOUND)
    db.delete(version)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
