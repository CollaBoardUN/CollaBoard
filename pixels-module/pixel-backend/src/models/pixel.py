"""
models/pixel.py
Modelos de datos y esquemas de validación (Pydantic).
Define la estructura exacta de los objetos que viajan por HTTP y WebSocket.
Solo se permite colocar 1 píxel a la vez.
"""

from typing import List
from pydantic import BaseModel, Field


class PixelPoint(BaseModel):
    """
    Representa un píxel individual en el lienzo.
    - x: Coordenada horizontal (columna, 0 a 199).
    - y: Coordenada vertical (fila, 0 a 199).
    - color: Código de color hexadecimal (ej: '#6366F1').
    """
    x: int = Field(..., ge=0, description="Coordenada X (0 a 199)")
    y: int = Field(..., ge=0, description="Coordenada Y (0 a 199)")
    color: str = Field(..., pattern=r"^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$", description="Color en formato hexadecimal (#RGB o #RRGGBB)")


class BoardStateResponse(BaseModel):
    """
    Respuesta enviada por el endpoint GET /api/pixels/board.
    Contiene las dimensiones del lienzo y la lista de píxeles que han sido pintados.
    """
    width: int
    height: int
    pixels: List[PixelPoint]


class ActivityItem(BaseModel):
    """
    Elemento individual del historial de actividad reciente.
    Muestra quién pintó qué píxel y en qué momento.
    """
    id: str
    x: int
    y: int
    color: str
    userId: str
    timestamp: str


class StatsResponse(BaseModel):
    """
    Respuesta enviada por el endpoint GET /api/pixels/stats.
    Muestra contadores globales del lienzo y cantidad de usuarios conectados.
    """
    totalPlaced: int
    uniqueContributors: int
    canvasWidth: int
    canvasHeight: int
    usersOnline: int


class ClientPlacePixelPayload(BaseModel):
    """
    Mensaje recibido desde el cliente mediante WebSocket para colocar un único píxel.
    Ejemplo: { "type": "PLACE_PIXEL", "x": 45, "y": 32, "color": "#6366F1", "userId": "Ana" }
    """
    type: str = "PLACE_PIXEL"
    x: int = Field(..., ge=0, lt=200, description="Coordenada X dentro del límite del lienzo")
    y: int = Field(..., ge=0, lt=200, description="Coordenada Y dentro del límite del lienzo")
    color: str = Field(..., pattern=r"^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$", description="Color hexadecimal válido")
    userId: str = Field(..., min_length=1, max_length=50, description="Identificador o alias del usuario")


class ServerPixelUpdated(BaseModel):
    """
    Mensaje de difusión (broadcast) emitido por el servidor a todos los clientes conectados
    cuando un píxel ha sido colocado con éxito.
    """
    type: str = "PIXEL_UPDATED"
    pixels: List[PixelPoint]
    userId: str
    timestamp: str


class ServerStatsUpdated(BaseModel):
    """
    Mensaje de difusión con las estadísticas actualizadas en tiempo real.
    Se emite cuando cambia el contador de usuarios online o el total de píxeles pintados.
    """
    type: str = "STATS_UPDATED"
    usersOnline: int
    totalPlaced: int
    uniqueContributors: int


class ServerCooldownActive(BaseModel):
    """
    Mensaje de error personal enviado a un cliente si intenta pintar
    antes de que termine su tiempo de espera (5 segundos).
    """
    type: str = "COOLDOWN_ACTIVE"
    remaining: float
    message: str


class ServerErrorMessage(BaseModel):
    """
    Mensaje de error genérico para notificar fallos de validación o formato.
    """
    type: str = "ERROR"
    message: str
