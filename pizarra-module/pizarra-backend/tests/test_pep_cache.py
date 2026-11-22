"""Pruebas del Policy Enforcement Point (PEP) de Pizarra y su caché de decisiones (Escenario S5)."""

import asyncio

import httpx

from app import internal_client


def test_pep_cache_aside_evita_llamadas_repetidas_y_expira_con_ttl(monkeypatch):
    internal_client.invalidate_access_cache()
    monkeypatch.setattr(internal_client, "AUTHZ_CACHE_TTL_SECONDS", 2.0)

    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        assert request.headers["X-Service-Token"] == internal_client.INTERNAL_SERVICE_TOKEN
        return httpx.Response(
            200,
            json={
                "board_id": "b-cache-1",
                "board_name": "Tablero Cache",
                "owner_id": "ana",
                "user_id": "beto",
                "role": "editor",
                "exists": True,
                "board_status": "active",
                "action": request.url.params.get("action"),
                "allowed": True,
                "permissions": ["canvas:view", "canvas:edit", "canvas:draft"],
                "cache_ttl_seconds": 3,
            },
        )

    async def scenario():
        transport = httpx.MockTransport(handler)
        async with httpx.AsyncClient(transport=transport) as mock_client:
            monkeypatch.setattr(internal_client, "get_http_client", lambda: mock_client)

            # 1) Primera consulta -> MISS (1 llamada HTTP al PDP)
            d1 = await internal_client.fetch_access_decision(
                "b-cache-1", "beto", token="jwt-beto", action="canvas:edit"
            )
            assert d1.exists is True
            assert d1.role == "editor"
            assert d1.allowed is True
            assert calls == 1

            # 2) Segunda consulta dentro del TTL (incluso por otra acción) -> HIT (0 llamadas HTTP)
            d2 = await internal_client.fetch_access_decision(
                "b-cache-1", "beto", token="jwt-beto", action="canvas:version:delete"
            )
            assert d2.exists is True
            assert d2.allowed is False
            assert calls == 1

            # 3) Invalidación explícita (p. ej. al purgar el tablero) -> fuerza nueva consulta
            internal_client.invalidate_access_cache("b-cache-1")
            d3 = await internal_client.fetch_access_decision(
                "b-cache-1", "beto", token="jwt-beto", action="canvas:view"
            )
            assert d3.allowed is True
            assert calls == 2

    asyncio.run(scenario())


def test_pep_falla_cerrado_si_el_pdp_no_responde(monkeypatch):
    internal_client.invalidate_access_cache()
    monkeypatch.setattr(internal_client, "AUTHZ_CACHE_TTL_SECONDS", 2.0)

    def broken_handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, json={"detail": "PDP caído"})

    async def scenario():
        transport = httpx.MockTransport(broken_handler)
        async with httpx.AsyncClient(transport=transport) as mock_client:
            monkeypatch.setattr(internal_client, "get_http_client", lambda: mock_client)
            exists, role = await internal_client.check_board_access("b-down", "ana")
            assert exists is False
            assert role is None

    asyncio.run(scenario())
