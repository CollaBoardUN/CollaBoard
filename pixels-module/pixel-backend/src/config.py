"""
config.py
Configuración global del backend del módulo Pixels (CollaBoard).
Define las variables de entorno con valores por defecto claros y seguros.
"""

from pydantic_settings import BaseSettings
from typing import List


class Settings(BaseSettings):
    """
    Clase de configuración basada en Pydantic.
    Lee variables de entorno automáticamente si existen,
    o utiliza estos valores por defecto.
    """

    # URL de conexión a la base de datos NoSQL (MongoDB)
    MONGODB_URL: str = "mongodb://nosql-db:27017"

    # Nombre de la base de datos en MongoDB
    DATABASE_NAME: str = "collaboard_pixels"

    # Dimensiones del lienzo de píxeles (matriz 200x200 = 40,000 píxeles)
    CANVAS_WIDTH: int = 200
    CANVAS_HEIGHT: int = 200

    # Tiempo de espera (cooldown) obligatorio en segundos entre colocaciones de píxeles
    COOLDOWN_SECONDS: float = 5.0

    # Dirección IP y puerto donde corre el servidor FastAPI
    HOST: str = "0.0.0.0"
    PORT: int = 8000

    # Lista de orígenes autorizados para CORS (Cross-Origin Resource Sharing)
    # Permite peticiones desde el frontend local (puerto 3000 o 5173)
    CORS_ORIGINS: List[str] = [
        "http://localhost:3000",
        "http://localhost:5173",
        "http://127.0.0.1:3000",
        "http://127.0.0.1:5173",
        "*",
    ]

    class Config:
        env_file = ".env"
        extra = "ignore"


# Instancia única de configuración reutilizada en toda la aplicación
settings = Settings()
