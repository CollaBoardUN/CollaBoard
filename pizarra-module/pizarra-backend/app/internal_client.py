"""Cliente HTTP asíncrono del Policy Enforcement Point (PEP) de Pizarra hacia el PDP (Colaboración).

- Evalúa acceso, rol y permisos con caché Cache-Aside: GET /internal/boards/{board_id}/access
- Notifica guardado exitoso: PATCH /internal/boards/{board_id}/metadata
- Falla cerrado (fail-closed): si Colaboración no responde o da error, nunca concede permisos.
"""

import logging
import time
from dataclasses import dataclass
from typing import Any

import httpx

from .config import (
    AUTHZ_CACHE_TTL_SECONDS,
    COLABORACION_SERVICE_URL,
    INTERNAL_SERVICE_TOKEN,
)

log = logging.getLogger(__name__)

# Timeout razonable para llamadas entre microservicios en la red interna
INTERNAL_TIMEOUT = 5.0

# Cliente persistente reutilizable
_client: httpx.AsyncClient | None = None


@dataclass(frozen=True)
class AccessDecision:
    """Decisión de autorización emitida por el PDP (`collaboration-api`)."""

    exists: bool
    role: str | None
    permissions: frozenset[str]
    allowed: bool
    expires_at: float


# Caché en memoria (Cache-Aside) indexada por (board_id, user_id).
_decision_cache: dict[tuple[str, str], AccessDecision] = {}
_cache_stats: dict[str, int] = {"hits": 0, "misses": 0, "invalidations": 0}


def get_http_client() -> httpx.AsyncClient:
    global _client
    if _client is None or _client.is_closed:
        _client = httpx.AsyncClient(timeout=INTERNAL_TIMEOUT)
    return _client


async def close_http_client() -> None:
    global _client
    if _client is not None and not _client.is_closed:
        await _client.aclose()
        _client = None


def invalidate_access_cache(board_id: str | None = None, user_id: str | None = None) -> None:
    """Invalida entradas de la caché del PEP (por tablero, por usuario o completa)."""
    _cache_stats["invalidations"] += 1
    if board_id is None and user_id is None:
        _decision_cache.clear()
        return
    keys_to_remove = [
        key
        for key in _decision_cache
        if (board_id is None or key[0] == board_id) and (user_id is None or key[1] == user_id)
    ]
    for key in keys_to_remove:
        _decision_cache.pop(key, None)


def get_access_cache_stats() -> dict[str, int]:
    """Contadores del PEP para pruebas y diagnóstico de rendimiento (Cache-Aside)."""
    return {**_cache_stats, "entries": len(_decision_cache)}


async def fetch_access_decision(
    board_id: str,
    user_id: str,
    token: str | None = None,
    action: str | None = None,
    *,
    bypass_cache: bool = False,
) -> AccessDecision:
    """Consulta al PDP (o a la caché local si el TTL está vigente) la decisión de acceso."""
    ttl_cfg = AUTHZ_CACHE_TTL_SECONDS
    cache_key = (board_id, user_id)
    now = time.monotonic()

    if not bypass_cache and ttl_cfg > 0:
        cached = _decision_cache.get(cache_key)
        if cached is not None and cached.expires_at > now:
            _cache_stats["hits"] += 1
            if not cached.exists or cached.role is None:
                return cached
            allowed = True if action is None else (action in cached.permissions)
            return AccessDecision(
                exists=cached.exists,
                role=cached.role,
                permissions=cached.permissions,
                allowed=allowed,
                expires_at=cached.expires_at,
            )

    _cache_stats["misses"] += 1
    url = f"{COLABORACION_SERVICE_URL.rstrip('/')}/internal/boards/{board_id}/access"
    headers: dict[str, str] = {
        "X-User-Id": user_id,
        "Accept": "application/json",
        "X-Service-Token": INTERNAL_SERVICE_TOKEN,
    }
    if token:
        headers["Authorization"] = f"Bearer {token}" if not token.startswith("Bearer ") else token
    params: dict[str, str] = {"user_id": user_id}
    if action:
        params["action"] = action

    try:
        client = get_http_client()
        resp = await client.get(url, params=params, headers=headers)

        if resp.status_code == 200:
            data = resp.json()
            role = data.get("role")
            raw_perms = data.get("permissions")
            perms = (
                frozenset(str(p) for p in raw_perms) if isinstance(raw_perms, list) else frozenset()
            )
            pdp_ttl = float(data.get("cache_ttl_seconds") or ttl_cfg or 0.0)
            effective_ttl = min(ttl_cfg, pdp_ttl) if (ttl_cfg > 0 and pdp_ttl > 0) else ttl_cfg
            allowed = bool(data.get("allowed", True))
            if action and perms:
                allowed = action in perms
            decision = AccessDecision(
                exists=True,
                role=role,
                permissions=perms,
                allowed=allowed,
                expires_at=time.monotonic() + max(0.0, effective_ttl),
            )
            if effective_ttl > 0:
                _decision_cache[cache_key] = decision
            return decision

        if resp.status_code in (403, 404):
            # El PDP responde 404 si no existe o no es miembro (no filtra existencia).
            _decision_cache.pop(cache_key, None)
            return AccessDecision(
                exists=False,
                role=None,
                permissions=frozenset(),
                allowed=False,
                expires_at=0.0,
            )

        log.warning(
            "Respuesta inesperada del PDP Colaboración para board %s (HTTP %s)",
            board_id,
            resp.status_code,
        )
    except Exception as exc:
        log.warning("Fallo consultando al PDP Colaboración en %s: %s", url, exc)

    # Fail-closed: ante cualquier caída o error del PDP, se niega el acceso.
    return AccessDecision(
        exists=False,
        role=None,
        permissions=frozenset(),
        allowed=False,
        expires_at=0.0,
    )


async def check_board_access(
    board_id: str,
    user_id: str,
    token: str | None = None,
    action: str | None = None,
) -> tuple[bool, str | None]:
    """Compatibilidad con llamadas `(exists, role_str)` en el PEP de Pizarra."""
    decision = await fetch_access_decision(board_id, user_id, token=token, action=action)
    if not decision.exists or decision.role is None:
        return False, None
    return True, decision.role


async def notify_board_saved(board_id: str, metadata: dict[str, Any]) -> bool:
    """Notifica al servicio de Colaboración que el tablero ha sido guardado exitosamente."""
    url = f"{COLABORACION_SERVICE_URL.rstrip('/')}/internal/boards/{board_id}/metadata"
    headers = {"Content-Type": "application/json", "X-Service-Token": INTERNAL_SERVICE_TOKEN}

    try:
        client = get_http_client()
        resp = await client.patch(url, json=metadata, headers=headers)
        if resp.is_success:
            log.info("Metadatos de guardado notificados a Colaboración para board %s", board_id)
            return True
        log.warning(
            "Fallo notificando metadatos a Colaboración para board %s: HTTP %s - %s",
            board_id,
            resp.status_code,
            resp.text,
        )
        return False
    except Exception as exc:
        log.warning("Error notificando guardado a Colaboración en %s: %s", url, exc)
        return False
