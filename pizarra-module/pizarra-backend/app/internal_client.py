"""Cliente HTTP asíncrono para comunicación interna con el microservicio de Colaboración.

- Valida acceso y rol: GET /internal/boards/{board_id}/access
- Notifica guardado exitoso: PATCH /internal/boards/{board_id}/metadata
"""

import logging
from typing import Any

import httpx

from .config import AUTH_DEV_MODE, COLABORACION_SERVICE_URL

log = logging.getLogger(__name__)

# Timeout razonable para llamadas entre microservicios en la red interna
INTERNAL_TIMEOUT = 5.0

# Cliente persistente reutilizable
_client: httpx.AsyncClient | None = None


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


async def check_board_access(
    board_id: str, user_id: str, token: str | None = None
) -> tuple[bool, str | None]:
    """Consulta al servicio de Colaboración si el usuario tiene acceso al tablero y su rol.

    Retorna: (existe_y_tiene_acceso: bool, role: str | None)
    Roles válidos: "viewer", "editor", "owner".
    """
    url = f"{COLABORACION_SERVICE_URL.rstrip('/')}/internal/boards/{board_id}/access"
    headers: dict[str, str] = {
        "X-User-Id": user_id,
        "Accept": "application/json",
    }
    if token:
        headers["Authorization"] = f"Bearer {token}" if not token.startswith("Bearer ") else token

    try:
        client = get_http_client()
        resp = await client.get(url, params={"user_id": user_id}, headers=headers)

        if resp.status_code == 200:
            data = resp.json()
            # El microservicio de colaboración devuelve {"role": "owner"|"editor"|"viewer", ...}
            role = data.get("role")
            return True, role
        elif resp.status_code == 404:
            return False, None
        elif resp.status_code == 403:
            return True, None
        else:
            log.warning(
                "Respuesta inesperada de Colaboración para board %s (HTTP %s): %s",
                board_id,
                resp.status_code,
                resp.text,
            )
            if AUTH_DEV_MODE:
                return True, "owner"
            return False, None
    except Exception as exc:
        log.warning("No se pudo conectar con Colaboración en %s: %s", url, exc)
        # Modo desarrollo / fallback offline si está activado
        if AUTH_DEV_MODE:
            return True, "owner"
        return False, None


async def notify_board_saved(board_id: str, metadata: dict[str, Any]) -> bool:
    """Notifica al servicio de Colaboración que el tablero ha sido guardado exitosamente.

    Payload enviado: PATCH /internal/boards/{board_id}/metadata
    {
        "element_count": int,
        "seq": int,
        "state_hash": str,
        "saved_at": str (ISO 8601)
    }
    """
    url = f"{COLABORACION_SERVICE_URL.rstrip('/')}/internal/boards/{board_id}/metadata"
    headers = {"Content-Type": "application/json"}

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
