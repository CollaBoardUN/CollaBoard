"""Configuración leída de variables de entorno (o de un archivo .env).

Así no hay contraseñas ni claves escritas en el código.
"""

import os

from dotenv import load_dotenv

load_dotenv()

# Conexión a PostgreSQL exclusiva del dominio de Colaboración (BoardDB). Formato:
# postgresql+psycopg://USUARIO:CLAVE@HOST:PUERTO/BASE
BOARD_DATABASE_URL = os.getenv(
    "BOARD_DATABASE_URL",
    os.getenv("DATABASE_URL", "postgresql+psycopg://postgres:postgres@localhost:5432/boards"),
)
DATABASE_URL = BOARD_DATABASE_URL

# Debe ser EXACTAMENTE la misma clave y algoritmo que usa el módulo de auth (Go)
# para firmar los tokens JWT.
JWT_SECRET = os.getenv("JWT_SECRET", "cambia-esto-por-la-clave-del-equipo")
JWT_ALGORITHM = os.getenv("JWT_ALGORITHM", "HS256")
JWT_ISSUER = os.getenv("JWT_ISSUER", "collaboard-auth")
JWT_REQUIRE_EXP = os.getenv("JWT_REQUIRE_EXP", "false").lower() == "true"

# Nombre de la cookie HttpOnly establecida por el servidor web SSR.
SESSION_COOKIE_NAME = os.getenv("SESSION_COOKIE_NAME", "cb_session")

# Modo desarrollo: permite probar sin login mandando el header X-User-Id.
# NUNCA dejarlo en "true" en producción.
AUTH_DEV_MODE = os.getenv("AUTH_DEV_MODE", "false").lower() == "true"

# URL pública del frontend / gateway: se usa para armar los links de invitación y para CORS.
FRONTEND_URL = os.getenv("FRONTEND_URL", "http://localhost:8088")

# Lista explícita de orígenes permitidos para CORS y validación de Origin con cookie.
_raw_origins = os.getenv(
    "ALLOWED_ORIGINS",
    f"{FRONTEND_URL},http://localhost:8088,http://127.0.0.1:8088,http://localhost:5173",
)
ALLOWED_ORIGINS: list[str] = list(
    dict.fromkeys(
        origin.strip().rstrip("/")
        for origin in _raw_origins.split(",")
        if origin.strip() and origin.strip() != "*"
    )
)

# Secreto compartido para autenticar llamadas internas entre servicios (/internal/*).
INTERNAL_SERVICE_TOKEN = os.getenv(
    "INTERNAL_SERVICE_TOKEN",
    os.getenv("NOTIFICATIONS_SERVICE_TOKEN", "token-de-servicio-solo-desarrollo"),
)

# URLs internas para el despachador de outbox (eventos de notificación y limpieza de borrado).
NOTIFICATIONS_URL = os.getenv("NOTIFICATIONS_URL", "http://notification-api:8085").rstrip("/")
PIZARRA_INTERNAL_URL = os.getenv("PIZARRA_INTERNAL_URL", "http://pizarra-backend:8000").rstrip("/")
CHAT_INTERNAL_URL = os.getenv("CHAT_INTERNAL_URL", "http://chat-api:8090").rstrip("/")

# Parámetros del despachador de outbox transaccional.
OUTBOX_ENABLED = os.getenv("OUTBOX_ENABLED", "true").lower() == "true"
OUTBOX_POLL_SECONDS = float(os.getenv("OUTBOX_POLL_SECONDS", "2.0"))
OUTBOX_HTTP_TIMEOUT_SECONDS = float(os.getenv("OUTBOX_HTTP_TIMEOUT_SECONDS", "4.0"))
OUTBOX_MAX_ATTEMPTS = int(os.getenv("OUTBOX_MAX_ATTEMPTS", "10"))
