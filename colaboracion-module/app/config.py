"""Configuración leída de variables de entorno (o de un archivo .env).

Así no hay contraseñas ni claves escritas en el código.
"""

import os

from dotenv import load_dotenv

load_dotenv()

# Conexión a PostgreSQL. Formato:
# postgresql+psycopg://USUARIO:CLAVE@HOST:PUERTO/BASE
DATABASE_URL = os.getenv(
    "DATABASE_URL",
    "postgresql+psycopg://postgres:postgres@localhost:5432/pizarra",
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
