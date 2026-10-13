"""
main.py
Punto de entrada principal del backend de Pixels (CollaBoard).
Define los endpoints REST y el canal WebSocket en tiempo real.
Restringido a colocar estrictamente 1 píxel a la vez.
"""

from contextlib import asynccontextmanager
from datetime import datetime, timezone
import json
import logging
import re
from typing import List

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import ValidationError

from .config import settings
from .database import db
from .models.pixel import (
    PixelPoint,
    BoardStateResponse,
    ActivityItem,
    StatsResponse,
    ClientPlacePixelPayload,
    ServerPixelUpdated,
    ServerStatsUpdated,
    ServerCooldownActive,
    ServerErrorMessage,
)
from .websockets import ws_manager

# Configuración básica de registro en consola
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s"
)
logger = logging.getLogger("pixels.main")

# Expresión regular para validar formato de color (#RGB o #RRGGBB)
HEX_COLOR_REGEX = re.compile(r"^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    Gestor del ciclo de vida de FastAPI.
    - Se ejecuta al iniciar: conecta con MongoDB.
    - Se ejecuta al apagar: cierra la conexión limpiamente.
    """
    logger.info("Iniciando servicio de Pixels Backend...")
    await db.connect()
    yield
    logger.info("Deteniendo servicio de Pixels Backend...")
    await db.close()


# Creación de la instancia de FastAPI
app = FastAPI(
    title="CollaBoard Pixels API",
    version="1.0.0",
    description="Microservicio backend para el módulo colaborativo de arte en píxeles (Wplace) de CollaBoard",
    lifespan=lifespan
)

# Configuración del middleware de CORS para permitir conexiones desde el cliente web
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health", tags=["Health"])
async def health_check():
    """
    Endpoint de comprobación de salud (Health Check).
    Verifica que el servicio esté activo y responda la base de datos.
    - Retorna: JSON con estado 'healthy', estado de BD y usuarios online.
    """
    db_ok = False
    try:
        if db.client is not None:
            await db.client.admin.command("ping")
            db_ok = True
    except Exception as e:
        logger.warning(f"Error comprobando MongoDB en health check: {e}")

    return {
        "status": "healthy" if db_ok else "degraded",
        "service": "pixel-backend",
        "databaseConnected": db_ok,
        "onlineUsers": ws_manager.get_online_count()
    }


@app.get("/api/pixels/board", response_model=BoardStateResponse, tags=["Pixels"])
async def get_board():
    """
    Endpoint HTTP REST para obtener el estado completo del lienzo.
    - Retorna: Dimensiones (200x200) y la lista de todos los píxeles modificados.
    """
    try:
        pixels = await db.get_all_pixels()
        return BoardStateResponse(
            width=settings.CANVAS_WIDTH,
            height=settings.CANVAS_HEIGHT,
            pixels=pixels
        )
    except Exception as e:
        logger.error(f"Error obteniendo estado del lienzo: {e}")
        raise HTTPException(status_code=500, detail="Error al recuperar el lienzo")


@app.get("/api/pixels/stats", response_model=StatsResponse, tags=["Pixels"])
async def get_stats():
    """
    Endpoint HTTP REST para obtener las métricas globales del lienzo.
    - Retorna: Total de píxeles pintados, autores únicos, tamaño y usuarios online.
    """
    try:
        online_users = ws_manager.get_online_count()
        return await db.get_stats(users_online=online_users)
    except Exception as e:
        logger.error(f"Error obteniendo estadísticas: {e}")
        raise HTTPException(status_code=500, detail="Error al recuperar estadísticas")


@app.get("/api/pixels/activity", response_model=List[ActivityItem], tags=["Pixels"])
async def get_activity():
    """
    Endpoint HTTP REST para obtener los últimos 15 eventos de colocación de píxeles.
    - Retorna: Lista cronológica de actividades recientes.
    """
    try:
        return await db.get_recent_activity(limit=15)
    except Exception as e:
        logger.error(f"Error obteniendo feed de actividad: {e}")
        raise HTTPException(status_code=500, detail="Error al recuperar actividad")


async def broadcast_current_stats():
    """
    Función auxiliar para difundir las estadísticas actualizadas a todos
    los clientes conectados por WebSocket.
    """
    try:
        online = ws_manager.get_online_count()
        stats = await db.get_stats(users_online=online)
        payload = ServerStatsUpdated(
            usersOnline=stats.usersOnline,
            totalPlaced=stats.totalPlaced,
            uniqueContributors=stats.uniqueContributors
        ).model_dump()
        await ws_manager.broadcast_json(payload)
    except Exception as e:
        logger.warning(f"Error difundiendo estadísticas: {e}")


@app.websocket("/ws/pixels")
async def websocket_pixel_endpoint(websocket: WebSocket):
    """
    Canal WebSocket bidireccional en tiempo real:
    - Escucha eventos entrantes del tipo 'PLACE_PIXEL'.
    - Coloca estrictamente UN SOLO píxel a la vez en (x, y).
    - Valida coordenadas y cooldown estricto de 5 segundos.
    - Persiste en MongoDB.
    - Difunde el cambio ('PIXEL_UPDATED' y 'STATS_UPDATED') a todos los clientes.
    """
    # 1. Registrar y aceptar la conexión
    await ws_manager.connect(websocket)

    # Actualizar contador de usuarios conectados para todos
    await broadcast_current_stats()

    client_ip = websocket.client.host if websocket.client else "unknown"

    try:
        while True:
            # Esperar mensaje entrante en formato texto
            raw_text = await websocket.receive_text()

            # Parsear JSON
            try:
                data = json.loads(raw_text)
            except json.JSONDecodeError:
                await ws_manager.send_personal_json(
                    websocket,
                    ServerErrorMessage(message="El payload debe ser un JSON válido").model_dump()
                )
                continue

            msg_type = data.get("type")

            # Manejo del evento de colocación de píxel
            if msg_type == "PLACE_PIXEL":
                # Validar campos con Pydantic
                try:
                    payload = ClientPlacePixelPayload(**data)
                except ValidationError as ve:
                    await ws_manager.send_personal_json(
                        websocket,
                        ServerErrorMessage(message=f"Error de validación: {ve.errors()}").model_dump()
                    )
                    continue

                # Validar límites del lienzo (0-199)
                if not (0 <= payload.x < settings.CANVAS_WIDTH and 0 <= payload.y < settings.CANVAS_HEIGHT):
                    await ws_manager.send_personal_json(
                        websocket,
                        ServerErrorMessage(message="Las coordenadas deben estar entre 0 y 199").model_dump()
                    )
                    continue

                # Validar formato de color
                if not HEX_COLOR_REGEX.match(payload.color):
                    await ws_manager.send_personal_json(
                        websocket,
                        ServerErrorMessage(message="Formato de color hexadecimal inválido").model_dump()
                    )
                    continue

                # Validar Cooldown (5 segundos por usuario/IP)
                cooldown_key = f"{payload.userId}:{client_ip}"
                is_allowed, remaining = await db.check_and_set_cooldown(
                    cooldown_key,
                    settings.COOLDOWN_SECONDS
                )

                if not is_allowed:
                    # Enviar mensaje de espera al cliente infractor
                    await ws_manager.send_personal_json(
                        websocket,
                        ServerCooldownActive(
                            remaining=remaining,
                            message=f"Cooldown activo. Espera {remaining:.1f}s antes de pintar"
                        ).model_dump()
                    )
                    continue

                # Crear el objeto del único píxel a colocar
                single_pixel = PixelPoint(
                    x=payload.x,
                    y=payload.y,
                    color=payload.color
                )

                # Guardar el píxel en MongoDB
                await db.place_pixel(single_pixel, user_id=payload.userId)

                now_iso = datetime.now(timezone.utc).isoformat()

                # Difundir el nuevo píxel a todos los clientes en tiempo real
                pixel_update_event = ServerPixelUpdated(
                    pixels=[single_pixel],
                    userId=payload.userId,
                    timestamp=now_iso
                ).model_dump()
                await ws_manager.broadcast_json(pixel_update_event)

                # Difundir las nuevas estadísticas
                await broadcast_current_stats()

            elif msg_type == "PING":
                # Soporte para heartbeat o ping-pong
                await ws_manager.send_personal_json(websocket, {"type": "PONG"})

            else:
                logger.debug(f"Tipo de mensaje no reconocido: {msg_type}")

    except WebSocketDisconnect:
        # El cliente cerró la pestaña o perdió conexión
        await ws_manager.disconnect(websocket)
        await broadcast_current_stats()
    except Exception as e:
        logger.error(f"Error inesperado en WebSocket: {e}")
        await ws_manager.disconnect(websocket)
        await broadcast_current_stats()


# Ejecución directa con uvicorn si se corre localmente con 'python src/main.py'
if __name__ == "__main__":
    import uvicorn
    uvicorn.run("src.main:app", host=settings.HOST, port=settings.PORT, reload=True)
