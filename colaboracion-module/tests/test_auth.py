import os
from datetime import UTC, datetime, timedelta

import jwt

from .conftest import token_for


def test_sin_token_da_401(client):
    assert client.get("/boards").status_code == 401


def test_token_invalido_da_401(client):
    r = client.get("/boards", headers={"Authorization": "Bearer basura"})
    assert r.status_code == 401


def test_token_firmado_con_otra_clave_da_401(client):
    t = jwt.encode({"sub": "ana"}, "otra-clave-distinta-de-al-menos-32-bytes!!", algorithm="HS256")
    r = client.get("/boards", headers={"Authorization": f"Bearer {t}"})
    assert r.status_code == 401


def test_token_con_issuer_incorrecto_da_401(client):
    t = token_for("ana", "Ana", issuer="otro-servicio")
    r = client.get("/boards", headers={"Authorization": f"Bearer {t}"})
    assert r.status_code == 401


def test_token_expirado_da_401(client):
    t = jwt.encode(
        {"sub": "ana", "exp": datetime.now(UTC) - timedelta(minutes=1)},
        os.environ["JWT_SECRET"],
        algorithm="HS256",
    )
    r = client.get("/boards", headers={"Authorization": f"Bearer {t}"})
    assert r.status_code == 401
    assert "expir" in r.json()["detail"]


def test_cookie_cb_session_sirve_en_get(client):
    t = token_for("ana", "Ana")
    r = client.get("/boards", cookies={"cb_session": t})
    assert r.status_code == 200


def test_cookie_cb_session_exige_origin_valido_en_post(client):
    t = token_for("ana", "Ana")
    # Sin Origin -> 403
    r_no_origin = client.post("/boards", json={"name": "X"}, cookies={"cb_session": t})
    assert r_no_origin.status_code == 403

    # Con Origin malicioso -> 403
    r_bad_origin = client.post(
        "/boards",
        json={"name": "X"},
        cookies={"cb_session": t},
        headers={"Origin": "https://sitio-atacante.evil"},
    )
    assert r_bad_origin.status_code == 403

    # Con Origin permitido -> 201
    r_ok = client.post(
        "/boards",
        json={"name": "Desde Cookie SSR"},
        cookies={"cb_session": t},
        headers={"Origin": "http://front.test"},
    )
    assert r_ok.status_code == 201
    assert r_ok.json()["owner_id"] == "ana"


def test_header_dev_ignorado_si_dev_mode_apagado(client):
    assert client.get("/boards", headers={"X-User-Id": "ana"}).status_code == 401


def test_health_y_request_id(client):
    r = client.get("/health", headers={"X-Request-Id": "req-test-123"})
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert body["service"] == "colaboracion-module"
    assert body["database"] == "board-db"
    assert r.headers["X-Request-Id"] == "req-test-123"


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
