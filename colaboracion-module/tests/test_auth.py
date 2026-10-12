from datetime import UTC, datetime, timedelta

import jwt


def test_sin_token_da_401(client):
    assert client.get("/boards").status_code == 401


def test_token_invalido_da_401(client):
    r = client.get("/boards", headers={"Authorization": "Bearer basura"})
    assert r.status_code == 401


def test_token_firmado_con_otra_clave_da_401(client):
    t = jwt.encode({"sub": "ana"}, "otra-clave-distinta-de-al-menos-32-bytes!!", algorithm="HS256")
    r = client.get("/boards", headers={"Authorization": f"Bearer {t}"})
    assert r.status_code == 401


def test_token_expirado_da_401(client):
    import os

    t = jwt.encode(
        {"sub": "ana", "exp": datetime.now(UTC) - timedelta(minutes=1)},
        os.environ["JWT_SECRET"],
        algorithm="HS256",
    )
    r = client.get("/boards", headers={"Authorization": f"Bearer {t}"})
    assert r.status_code == 401
    assert "expir" in r.json()["detail"]


def test_header_dev_ignorado_si_dev_mode_apagado(client):
    assert client.get("/boards", headers={"X-User-Id": "ana"}).status_code == 401


def test_health(client):
    assert client.get("/health").json() == {"status": "ok"}


def test_login_de_desarrollo_emite_token_valido(client):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from app.routers import dev_auth

    dev = FastAPI()
    dev.include_router(dev_auth.router)
    token = (
        TestClient(dev)
        .post("/dev/token", json={"user_id": "zoe", "name": "Zoe"})
        .json()["access_token"]
    )
    r = client.post("/boards", json={"name": "X"}, headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 201
    assert r.json()["owner_id"] == "zoe"


def test_endpoint_dev_no_existe_si_dev_mode_apagado(client):
    assert client.post("/dev/token", json={"user_id": "x"}).status_code == 404
