"""Configuración leída de variables de entorno (o de un archivo .env).

Así no hay contraseñas ni claves escritas en el código.
"""

import os

from dotenv import load_dotenv

load_dotenv()

# Conexión a PostgreSQL (CanvasDB exclusiva de persistencia). Formato:
# postgresql+psycopg://USUARIO:CLAVE@HOST:PUERTO/BASE
CANVAS_DATABASE_URL = os.getenv(
    "CANVAS_DATABASE_URL",
    os.getenv("DATABASE_URL", "postgresql+psycopg://postgres:postgres@localhost:5432/canvas"),
)
DATABASE_URL = CANVAS_DATABASE_URL

# URL interna del servicio de Colaboración (para validar accesos y notificar metadata)
COLABORACION_SERVICE_URL = os.getenv(
    "COLABORACION_SERVICE_URL",
    os.getenv("COLABORACION_URL", "http://colaboracion-backend:8000"),
)

# Debe ser EXACTAMENTE la misma clave y algoritmo que usa el módulo de auth
# de tu compañero para firmar los tokens JWT.
JWT_SECRET = os.getenv("JWT_SECRET", "cambia-esto-por-la-clave-del-equipo")
JWT_ALGORITHM = os.getenv("JWT_ALGORITHM", "HS256")

# Modo desarrollo: permite probar sin login mandando el header X-User-Id.
# NUNCA dejarlo en "true" en producción.
AUTH_DEV_MODE = os.getenv("AUTH_DEV_MODE", "false").lower() == "true"

# URL del frontend: se usa para armar los links de invitación y para CORS.
FRONTEND_URL = os.getenv("FRONTEND_URL", "http://localhost:5173")

# Autosave (Persona 4): segundos tras el último cambio antes de guardar, y tope
# de espera si se sigue dibujando sin parar.
AUTOSAVE_DEBOUNCE_SECONDS = float(os.getenv("AUTOSAVE_DEBOUNCE_SECONDS", "2"))
AUTOSAVE_MAX_WAIT_SECONDS = float(os.getenv("AUTOSAVE_MAX_WAIT_SECONDS", "10"))

# Cada cuántos segundos (como mucho) se crea una versión automática mientras se edita.
AUTOSAVE_SNAPSHOT_EVERY_SECONDS = float(os.getenv("AUTOSAVE_SNAPSHOT_EVERY_SECONDS", "300"))

INTERNAL_SERVICE_TOKEN = os.getenv(
    "INTERNAL_SERVICE_TOKEN",
    os.getenv("NOTIFICATIONS_SERVICE_TOKEN", "token-de-servicio-solo-desarrollo"),
)
