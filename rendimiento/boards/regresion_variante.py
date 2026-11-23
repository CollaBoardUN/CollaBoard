"""Verificaciones de la variante, ejecutadas dentro de su imagen experimental."""

import asyncio
import os
import secrets
import sys
import tempfile
import time
from pathlib import Path
from types import SimpleNamespace


def verify_postgres():
    from sqlalchemy import text

    from app.database import OutboxSessionLocal, SessionLocal, engine, outbox_engine

    assert engine is not outbox_engine
    assert engine.pool.size() == 25 and engine.pool._max_overflow == 25 and engine.pool.timeout() == 5
    assert outbox_engine.pool.size() == 2 and outbox_engine.pool._max_overflow == 0
    assert outbox_engine.pool.timeout() == 5
    with SessionLocal() as api, OutboxSessionLocal() as outbox:
        assert api.scalar(text("SELECT 1")) == 1 and outbox.scalar(text("SELECT 1")) == 1
        assert engine.pool.checkedout() == 1 and outbox_engine.pool.checkedout() == 1
    assert engine.pool.checkedout() == 0 and outbox_engine.pool.checkedout() == 0
    print("postgres: pools API 25+25 y outbox 2+0; conexiones devueltas después de SELECT 1")


def verify_sqlite(directory):
    secret = secrets.token_hex(32)
    local_db = f"sqlite:///{Path(directory) / 'regression.db'}"
    os.environ.update(DATABASE_URL=local_db, BOARD_DATABASE_URL=local_db, JWT_SECRET=secret,
                      JWT_ISSUER="collaboard-auth", AUTH_DEV_MODE="false", OUTBOX_ENABLED="false",
                      INTERNAL_SERVICE_TOKEN=secrets.token_hex(32))
    import httpx
    import jwt
    from fastapi.testclient import TestClient
    from sqlalchemy import event, select

    from app.database import Base, SessionLocal, engine
    from app.main import app
    from app.models import Board, BoardStatus, OutboxEvent, OutboxStatus, Role
    from app.outbox import dispatch_pending_once, enqueue_invite_accepted
    from app.routers.boards import list_my_boards

    def headers(identity, signing_key=secret):
        token = jwt.encode({"sub": identity, "iss": "collaboard-auth", "exp": int(time.time()) + 60},
                           signing_key, algorithm="HS256")
        return {"Authorization": f"Bearer {token}"}

    owner = headers("perf-owner")
    outsider = headers("perf-outsider")
    Base.metadata.create_all(engine)
    with TestClient(app) as client:
        ids = set()
        for index in range(10):
            response = client.post("/boards", json={"name": f"Private board {index}"}, headers=owner)
            assert response.status_code == 201
            ids.add(response.json()["id"])
        identifier = next(iter(ids))
        assert client.get("/boards").status_code == 401
        assert client.get("/boards", headers=headers("perf-owner", secrets.token_hex(32))).status_code == 401
        assert client.get("/boards", headers=outsider).json() == []
        assert client.get(f"/boards/{identifier}", headers=outsider).status_code == 404

        statements = []

        def count_sql(conn, cursor, statement, parameters, context, executemany):
            statements.append(statement)

        event.listen(engine, "before_cursor_execute", count_sql)
        try:
            listing = client.get("/boards", headers=owner)
            assert listing.status_code == 200
            assert len(listing.json()) == 10 and {row["id"] for row in listing.json()} == ids
            assert len(statements) == 1 and statements[0].lstrip().upper().startswith("SELECT")
            with SessionLocal() as db:
                assert len(list_my_boards(db, SimpleNamespace(id="perf-owner"))) == 10
                assert not db.in_transaction()
        finally:
            event.remove(engine, "before_cursor_execute", count_sql)
    print("sqlite: JWT y tableros privados; 10 tableros con un SELECT; transacción liberada en el handler")

    with SessionLocal() as db:
        board = db.get(Board, identifier)
        entry = enqueue_invite_accepted(db, board=board, actor_id="perf-outsider",
                                        actor_name="Guest", role=Role.viewer)
        db.commit()
        event_id = entry.event_id

    delivered = []

    def mock(request):
        assert request.headers["X-Service-Token"] == os.environ["INTERNAL_SERVICE_TOKEN"]
        delivered.append(request.headers["X-Event-Id"])
        return httpx.Response(503 if len(delivered) == 1 else 202)

    async def try_dispatch():
        async with httpx.AsyncClient(transport=httpx.MockTransport(mock)) as client:
            assert await dispatch_pending_once(client, ignore_schedule=True) == 0
            assert await dispatch_pending_once(client, ignore_schedule=True) == 1

    asyncio.run(try_dispatch())
    with SessionLocal() as db:
        entry = db.scalar(select(OutboxEvent).where(OutboxEvent.event_id == event_id))
        assert entry.status == OutboxStatus.sent.value and entry.attempts == 2
    assert delivered == [event_id, event_id]
    print("sqlite: outbox conserva el identificador y reintenta 503 → 202")

    with TestClient(app) as client:
        assert client.delete(f"/boards/{identifier}", headers=owner).status_code == 204
        assert client.get(f"/boards/{identifier}", headers=owner).status_code == 404
        assert len(client.get("/boards", headers=owner).json()) == 9

    async def finish_cleanup():
        transport = httpx.MockTransport(lambda request: httpx.Response(204))
        async with httpx.AsyncClient(transport=transport) as client:
            assert await dispatch_pending_once(client, ignore_schedule=True) == 2

    asyncio.run(finish_cleanup())
    with SessionLocal() as db:
        assert db.get(Board, identifier).status == BoardStatus.deleted.value
    print("sqlite: las dos confirmaciones de limpieza completan el borrado coordinado")


if __name__ == "__main__":
    if sys.argv[1:] == ["postgres"]:
        verify_postgres()
    else:
        with tempfile.TemporaryDirectory() as directory:
            verify_sqlite(directory)
