"""
main.py
Módulo Lógico de Colaboración (Paquete B) - CollaBoard.
Única autoridad sobre tableros, membresías, roles (owner, editor, viewer),
enlaces de invitación, autorización interna (/internal/*) y outbox transaccional.
"""

import logging
import time
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, HTTPException, Request, Response, status
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text
from sqlalchemy.orm import Session

from .config import ALLOWED_ORIGINS, AUTH_DEV_MODE
from .database import get_db
from .outbox import outbox_worker
from .routers import boards, dev_auth, internal, invites

log = logging.getLogger("collaboard.colaboracion")

# Uvicorn solo configura sus propios loggers: sin esto, los INFO de la app (la
# línea "http request_id=...") se descartaban y no había correlación en los logs.
_app_log = logging.getLogger("collaboard")
if not _app_log.handlers:
    _handler = logging.StreamHandler()
    _handler.setFormatter(logging.Formatter("%(levelname)s %(name)s %(message)s"))
    _app_log.addHandler(_handler)
    _app_log.setLevel(logging.INFO)


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    await outbox_worker.start()
    try:
        yield
    finally:
        await outbox_worker.stop()


app = FastAPI(
    lifespan=lifespan,
    title="CollaBoard — Módulo Lógico de Colaboración",
    version="2.0.0",
    description=(
        "Autoridad única de tableros, colaboradores, roles, invitaciones y "
        "autorización interna sobre BoardDB."
    ),
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["X-Request-Id"],
)


@app.middleware("http")
async def request_id_and_log(request: Request, call_next) -> Response:
    """Propaga X-Request-Id y deja rastro correlacionado en logs (sin registrar tokens)."""
    req_id = (request.headers.get("x-request-id") or "").strip() or str(uuid.uuid4())
    request.state.request_id = req_id
    started = time.perf_counter()
    response: Response = await call_next(request)
    elapsed_ms = round((time.perf_counter() - started) * 1000, 2)
    response.headers["X-Request-Id"] = req_id
    log.info(
        "http request_id=%s method=%s path=%s status=%s ms=%s",
        req_id,
        request.method,
        request.url.path,
        response.status_code,
        elapsed_ms,
    )
    return response


# Routers públicos e internos
app.include_router(boards.router)
app.include_router(invites.router)
app.include_router(internal.router)

if AUTH_DEV_MODE:
    app.include_router(dev_auth.router)


@app.get("/health", tags=["Sistema"])
def health(db: Session = Depends(get_db)):
    try:
        db.execute(text("SELECT 1"))
    except Exception as exc:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "BoardDB no disponible",
        ) from exc
    return {"status": "ok", "service": "colaboracion-module", "database": "board-db"}
