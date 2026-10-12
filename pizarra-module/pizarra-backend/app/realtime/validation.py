"""Validación y limpieza de los elementos que llegan por WebSocket.

Nunca confiamos en lo que manda el cliente: solo pasan los campos conocidos,
con el tipo correcto y con tamaños acotados. El formato de un elemento es el
mismo `CanvasElement` del frontend (src/domain/models/canvas.ts).
"""

import math
from typing import Any

MAX_ELEMENTS = 5000  # elementos por tablero
MAX_OPS_PER_MESSAGE = 5000
MAX_POINTS = 50_000  # números en `points` (x e y alternados)
MAX_TEXT = 5000
MAX_ID = 64

DRAWABLE_TYPES = {
    "pencil",
    "line",
    "rectangle",
    "circle",
    "triangle",
    "star",
    "arrow",
    "sticky",
}

REQUIRED_NUMBERS = ("x", "y", "width", "height")
NUMBER_FIELDS = {"x", "y", "width", "height", "strokeWidth"}
SHORT_STRING_FIELDS = {"fillColor", "strokeColor", "textColor", "fontFamily"}
OPTIONAL_FIELDS = {"points", "text", "textColor", "fontFamily"}
# Campos que un `update` puede cambiar (id, type y authorId son inmutables).
PATCHABLE_FIELDS = NUMBER_FIELDS | SHORT_STRING_FIELDS | {"points", "text"}


def _is_number(value: Any) -> bool:
    return isinstance(value, int | float) and not isinstance(value, bool) and math.isfinite(value)


def _valid_field(name: str, value: Any) -> bool:
    if name in NUMBER_FIELDS:
        return _is_number(value)
    if name in SHORT_STRING_FIELDS:
        return isinstance(value, str) and len(value) <= 100
    if name == "text":
        return isinstance(value, str) and len(value) <= MAX_TEXT
    if name == "points":
        return (
            isinstance(value, list)
            and len(value) <= MAX_POINTS
            and all(_is_number(n) for n in value)
        )
    return False


def valid_id(value: Any) -> bool:
    return isinstance(value, str) and 0 < len(value) <= MAX_ID


def clean_element(raw: Any, author_id: str) -> dict | None:
    """Devuelve un elemento completo y seguro, o None si no es válido."""
    if not isinstance(raw, dict) or not valid_id(raw.get("id")):
        return None
    if raw.get("type") not in DRAWABLE_TYPES:
        return None
    if not all(_is_number(raw.get(name)) for name in REQUIRED_NUMBERS):
        return None

    element: dict = {"id": raw["id"], "type": raw["type"], "authorId": author_id}
    for name in PATCHABLE_FIELDS:
        value = raw.get(name)
        if value is None:
            continue
        if not _valid_field(name, value):
            return None
        element[name] = value
    return element


def clean_patch(raw: Any) -> dict | None:
    """Limpia un `update`. Un valor `None` borra un campo opcional."""
    if not isinstance(raw, dict):
        return None
    patch: dict = {}
    for name, value in raw.items():
        if name not in PATCHABLE_FIELDS:
            continue
        if value is None:
            if name in OPTIONAL_FIELDS:
                patch[name] = None
            continue
        if not _valid_field(name, value):
            return None
        patch[name] = value
    return patch or None


def clean_cursor(x: Any, y: Any) -> tuple[float, float] | None:
    if _is_number(x) and _is_number(y):
        return float(x), float(y)
    return None
