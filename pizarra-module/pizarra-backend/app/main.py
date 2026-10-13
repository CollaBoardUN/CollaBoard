"""Punto de entrada de la API.

Ejecutar:  uvicorn app.main:app --reload
Documentación interactiva:  http://localhost:8000/docs
"""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import AUTH_DEV_MODE, FRONTEND_URL
from .persistence.autosave import autosaver
from .persistence.store import load_state_async
from .realtime.rooms import manager
from .routers import boards, dev_auth, invites, versions, ws

# Las tablas se crean con migraciones:  alembic upgrade head


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    # Persistencia: al crear una sala se precarga el estado guardado y cada
    # lote de operaciones agenda un autosave.
    manager.loader = load_state_async
    manager.on_ops = autosaver.on_ops
    try:
        yield
    finally:
        await autosaver.flush_all()  # no perder lo que aún no se había guardado


app = FastAPI(
    lifespan=lifespan,
    title="Pizarra colaborativa — Tableros y colaboradores",
    version="1.0.0",
    description="Módulo de la Persona 1: CRUD de tableros, roles y compartir por link.",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[FRONTEND_URL],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(boards.router)
app.include_router(invites.router)
app.include_router(versions.router)
app.include_router(ws.router)

if AUTH_DEV_MODE:
    app.include_router(dev_auth.router)


@app.get("/health", tags=["Sistema"])
def health():
    return {"status": "ok"}
