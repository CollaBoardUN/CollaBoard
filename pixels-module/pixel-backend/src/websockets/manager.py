"""
websockets/manager.py
Gestor centralizado de conexiones WebSocket (ConnectionManager).
Controla los clientes conectados, difusión (broadcast) y concurrencia.
"""

from typing import Set, Dict, Any
from fastapi import WebSocket
import logging
import json
import asyncio

logger = logging.getLogger("pixels.websockets")


class ConnectionManager:
    """
    Administra la lista de sockets activos y provee métodos para enviar
    mensajes individuales o difundirlos a todos los clientes.
    """

    def __init__(self):
        # Conjunto de clientes WebSocket actualmente conectados
        self.active_connections: Set[WebSocket] = set()
        # Bloqueo asíncrono para prevenir condiciones de carrera al modificar la lista
        self._lock = asyncio.Lock()

    async def connect(self, websocket: WebSocket):
        """
        Acepta una nueva conexión WebSocket entrante y la añade al conjunto de activos.
        - Parámetros:
            * websocket: Objeto WebSocket de FastAPI.
        """
        await websocket.accept()
        async with self._lock:
            self.active_connections.add(websocket)
        logger.info(f"Cliente WebSocket conectado. Conexiones activas: {len(self.active_connections)}")

    async def disconnect(self, websocket: WebSocket):
        """
        Remueve un cliente del conjunto de activos tras desconectarse o fallar la conexión.
        - Parámetros:
            * websocket: Objeto WebSocket que se desconectó.
        """
        async with self._lock:
            self.active_connections.discard(websocket)
        logger.info(f"Cliente WebSocket desconectado. Conexiones activas: {len(self.active_connections)}")

    def get_online_count(self) -> int:
        """
        Retorna la cantidad exacta de clientes conectados en tiempo real.
        - Retorna: Entero con el número de sockets activos.
        """
        return len(self.active_connections)

    async def send_personal_json(self, websocket: WebSocket, data: Dict[str, Any]):
        """
        Envía un mensaje JSON exclusivamente al cliente indicado (ej: errores o alertas de cooldown).
        - Parámetros:
            * websocket: Conexión destino.
            * data: Diccionario con la estructura del mensaje.
        """
        try:
            await websocket.send_text(json.dumps(data))
        except Exception as e:
            logger.warning(f"No se pudo enviar mensaje personal al cliente: {e}")

    async def broadcast_json(self, data: Dict[str, Any]):
        """
        Difunde un mensaje JSON a absolutamente todos los clientes conectados.
        Detecta y limpia de forma automática conexiones que se hayan cerrado de manera inesperada.
        - Parámetros:
            * data: Diccionario con los datos a difundir (ej: PIXEL_UPDATED, STATS_UPDATED).
        """
        if not self.active_connections:
            return

        text = json.dumps(data)
        disconnected = []

        # Copiamos la lista bajo el bloqueo para iterar de manera segura
        async with self._lock:
            targets = list(self.active_connections)

        for connection in targets:
            try:
                await connection.send_text(text)
            except Exception as e:
                logger.warning(f"Error difundiendo mensaje a cliente, marcado para remoción: {e}")
                disconnected.append(connection)

        # Si hubo conexiones caídas, se eliminan del conjunto
        if disconnected:
            async with self._lock:
                for dead_conn in disconnected:
                    self.active_connections.discard(dead_conn)


# Instancia compartida del gestor de WebSockets
ws_manager = ConnectionManager()
