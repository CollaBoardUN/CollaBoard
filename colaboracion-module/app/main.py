"""
main.py
Módulo Lógico de Colaboración (Persona 1) - CollaBoard.
Responsable exclusivo de la gestión de tableros, membresías, roles (owner, editor, viewer),
enlaces de invitación y control de acceso (permissions).
"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import AUTH_DEV_MODE, FRONTEND_URL
from .routers import boards, dev_auth, invites

app = FastAPI(
    title="CollaBoard — Módulo Lógico de Colaboración",
    version="1.0.0",
    description="Microservicio de Colaboración: Gestión de tableros, colaboradores, roles y permisos de acceso.",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[FRONTEND_URL, "*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Routers de colaboración y acceso
app.include_router(boards.router)
app.include_router(invites.router)

if AUTH_DEV_MODE:
    app.include_router(dev_auth.router)


@app.get("/health", tags=["Sistema"])
def health():
    return {"status": "ok", "service": "colaboracion-module"}
