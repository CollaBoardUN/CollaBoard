"""
database/connection.py
Capa de acceso y persistencia en la base de datos NoSQL (MongoDB).
Utiliza 'motor' para operaciones asíncronas de alto rendimiento con FastAPI.
Maneja la colocación de un único píxel a la vez.
"""

from datetime import datetime, timezone
from typing import List, Tuple, Optional
import logging
from motor.motor_asyncio import AsyncIOMotorClient, AsyncIOMotorDatabase
from ..config import settings
from ..models.pixel import PixelPoint, ActivityItem, StatsResponse

logger = logging.getLogger("pixels.database")


class Database:
    """
    Gestiona la conexión y las consultas hacia MongoDB.
    """
    client: Optional[AsyncIOMotorClient] = None
    db: Optional[AsyncIOMotorDatabase] = None

    async def connect(self):
        """
        Inicia la conexión con el servidor MongoDB y crea los índices necesarios.
        - Llamada automáticamente al arrancar la aplicación FastAPI.
        """
        try:
            logger.info(f"Conectando a MongoDB en {settings.MONGODB_URL}...")
            self.client = AsyncIOMotorClient(settings.MONGODB_URL, serverSelectionTimeoutMS=5000)
            self.db = self.client[settings.DATABASE_NAME]

            # Verifica conectividad enviando comando ping
            await self.client.admin.command('ping')
            logger.info("Conexión exitosa con MongoDB.")

            # Índice 1: Coordenadas (x, y) para búsquedas rápidas en el lienzo
            await self.db.pixels.create_index([("x", 1), ("y", 1)])

            # Índice 2: Timestamp descendente para el feed de actividad
            await self.db.activity.create_index([("timestamp", -1)])

            # Índice 3: TTL (Time-To-Live) para limpiar registros de cooldown automáticamente tras 60s
            await self.db.cooldowns.create_index("lastPlaced", expireAfterSeconds=60)
            logger.info("Índices de MongoDB verificados y listos.")
        except Exception as e:
            logger.error(f"Error conectando a MongoDB: {e}")
            raise e

    async def close(self):
        """
        Cierra de forma ordenada la conexión con MongoDB al apagar el servidor.
        """
        if self.client:
            self.client.close()
            logger.info("Conexión con MongoDB cerrada.")

    async def get_all_pixels(self) -> List[PixelPoint]:
        """
        Obtiene todos los píxeles actualmente coloreados en el tablero.
        - Retorna: Lista de objetos PixelPoint con x, y y color.
        """
        cursor = self.db.pixels.find({}, {"_id": 0, "x": 1, "y": 1, "color": 1})
        pixels: List[PixelPoint] = []
        async for doc in cursor:
            pixels.append(PixelPoint(x=doc["x"], y=doc["y"], color=doc["color"]))
        return pixels

    async def check_and_set_cooldown(self, identifier: str, cooldown_duration: float) -> Tuple[bool, float]:
        """
        Valida si un usuario o IP está dentro de su tiempo de cooldown (5s).
        - Parámetros:
            * identifier: Cadena única (ej: 'Ana:192.168.1.1').
            * cooldown_duration: Duración obligatoria en segundos (5.0s).
        - Retorna:
            * (True, 0.0) si se le permite colocar el píxel (y actualiza el timestamp).
            * (False, tiempo_restante) si aún debe esperar.
        """
        now = datetime.now(timezone.utc)
        record = await self.db.cooldowns.find_one({"_id": identifier})

        if record and "lastPlaced" in record:
            last_placed = record["lastPlaced"]
            if last_placed.tzinfo is None:
                last_placed = last_placed.replace(tzinfo=timezone.utc)
            elapsed = (now - last_placed).total_seconds()

            if elapsed < cooldown_duration:
                remaining = round(cooldown_duration - elapsed, 2)
                return False, remaining

        # Actualiza la última colocación con la fecha y hora actual
        await self.db.cooldowns.update_one(
            {"_id": identifier},
            {"$set": {"lastPlaced": now}},
            upsert=True
        )
        return True, 0.0

    async def place_pixel(self, pixel: PixelPoint, user_id: str) -> PixelPoint:
        """
        Guarda exactamente 1 píxel en MongoDB y registra su evento en el historial.
        - Parámetros:
            * pixel: Objeto PixelPoint con x, y y color.
            * user_id: Nombre del usuario que colocó el píxel.
        - Retorna: El PixelPoint persistido.
        """
        now = datetime.now(timezone.utc)

        # 1. Guardar o actualizar la celda en la colección 'pixels'
        await self.db.pixels.update_one(
            {"_id": f"{pixel.x}_{pixel.y}"},
            {
                "$set": {
                    "x": pixel.x,
                    "y": pixel.y,
                    "color": pixel.color,
                    "userId": user_id,
                    "updatedAt": now
                }
            },
            upsert=True
        )

        # 2. Registrar el evento en el feed de actividad
        activity_doc = {
            "x": pixel.x,
            "y": pixel.y,
            "color": pixel.color,
            "userId": user_id,
            "timestamp": now
        }
        await self.db.activity.insert_one(activity_doc)

        # 3. Incrementar contadores globales en la colección 'metadata'
        await self.db.metadata.update_one(
            {"_id": "stats"},
            {
                "$inc": {"totalPlaced": 1},
                "$addToSet": {"contributors": user_id}
            },
            upsert=True
        )

        return pixel

    async def get_stats(self, users_online: int) -> StatsResponse:
        """
        Calcula y retorna las estadísticas agregadas del lienzo.
        - Parámetros:
            * users_online: Número actual de conexiones activas por WebSocket.
        - Retorna: Objeto StatsResponse con métricas actualizadas.
        """
        stats_doc = await self.db.metadata.find_one({"_id": "stats"})
        total_placed = stats_doc.get("totalPlaced", 0) if stats_doc else 0
        contributors = stats_doc.get("contributors", []) if stats_doc else []
        unique_contributors = len(contributors)

        return StatsResponse(
            totalPlaced=total_placed,
            uniqueContributors=unique_contributors,
            canvasWidth=settings.CANVAS_WIDTH,
            canvasHeight=settings.CANVAS_HEIGHT,
            usersOnline=users_online
        )

    async def get_recent_activity(self, limit: int = 15) -> List[ActivityItem]:
        """
        Recupera los últimos eventos de colocación de píxeles ordenados por fecha.
        - Parámetros:
            * limit: Cantidad máxima de eventos a recuperar (por defecto 15).
        - Retorna: Lista de objetos ActivityItem.
        """
        cursor = self.db.activity.find().sort("timestamp", -1).limit(limit)
        items: List[ActivityItem] = []
        async for doc in cursor:
            ts = doc["timestamp"]
            ts_str = ts.isoformat() if isinstance(ts, datetime) else str(ts)
            items.append(
                ActivityItem(
                    id=str(doc["_id"]),
                    x=doc["x"],
                    y=doc["y"],
                    color=doc["color"],
                    userId=doc.get("userId", "Anon"),
                    timestamp=ts_str
                )
            )
        return items


# Instancia única de la base de datos para toda la aplicación
db = Database()
