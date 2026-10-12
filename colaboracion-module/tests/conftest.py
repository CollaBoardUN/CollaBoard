"""Configuración común de los tests.

Usamos SQLite en un archivo temporal para no necesitar PostgreSQL al probar.
Las variables de entorno se fijan ANTES de importar la app.
"""

import os
import tempfile

# Por defecto SQLite. Para probar contra PostgreSQL (como hace la CI):
#   TEST_DATABASE_URL=postgresql+psycopg://... pytest
_db_file = os.path.join(tempfile.mkdtemp(), "test.db")
os.environ["DATABASE_URL"] = os.getenv("TEST_DATABASE_URL", f"sqlite:///{_db_file}")
os.environ["JWT_SECRET"] = "secreto-de-pruebas-con-longitud-suficiente-32b"
os.environ["AUTH_DEV_MODE"] = "false"
os.environ["FRONTEND_URL"] = "http://front.test"

import jwt  # noqa: E402
import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.database import Base, engine  # noqa: E402
from app.main import app  # noqa: E402


@pytest.fixture(autouse=True)
def fresh_db():
    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)
    yield


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


def token_for(user_id: str, name: str | None = None) -> str:
    payload = {"sub": user_id}
    if name:
        payload["name"] = name
    return jwt.encode(payload, os.environ["JWT_SECRET"], algorithm="HS256")


def auth(user_id: str, name: str | None = None) -> dict:
    return {"Authorization": f"Bearer {token_for(user_id, name)}"}


@pytest.fixture
def ana():
    return auth("ana", "Ana")


@pytest.fixture
def beto():
    return auth("beto", "Beto")


@pytest.fixture
def caro():
    return auth("caro", "Caro")


@pytest.fixture
def board(client, ana):
    """Un tablero creado por Ana (owner)."""
    r = client.post("/boards", json={"name": "Tablero de Ana"}, headers=ana)
    assert r.status_code == 201
    return r.json()


def invite(client, owner_headers, board_id, role="editor"):
    r = client.post(f"/boards/{board_id}/invite", json={"role": role}, headers=owner_headers)
    assert r.status_code == 201, r.text
    return r.json()


def join(client, headers, token):
    r = client.post(f"/invites/{token}/accept", headers=headers)
    assert r.status_code == 200, r.text
    return r.json()
