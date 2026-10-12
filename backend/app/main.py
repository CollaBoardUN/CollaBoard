"""Punto de entrada de la API.

Ejecutar:  uvicorn app.main:app --reload
Documentación interactiva:  http://localhost:8000/docs
"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import AUTH_DEV_MODE, FRONTEND_URL
from .routers import boards, dev_auth, invites

# Las tablas se crean con migraciones:  alembic upgrade head

app = FastAPI(
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

if AUTH_DEV_MODE:
    app.include_router(dev_auth.router)


@app.get("/health", tags=["Sistema"])
def health():
    return {"status": "ok"}
