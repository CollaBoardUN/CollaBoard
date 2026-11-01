"""Asignación de colores por tablero, sin cambiar el protocolo de presencia."""

import asyncio

from app.models import Role
from app.realtime.rooms import PALETTE, Connection, Room


class Socket:
    def __init__(self):
        self.messages = []

    async def send_json(self, message):
        self.messages.append(message)


def connection(user):
    return Connection(ws=Socket(), user_id=user, name=user, role=Role.editor)


def test_distintos_usuarios_distinto_color_y_pestanas_comparten_color():
    async def scenario():
        room = Room("board-colors")
        ana, beto, ana2 = connection("ana"), connection("beto"), connection("ana")
        for conn in (ana, beto, ana2):
            await room.join(conn)
        assert ana.color != beto.color
        assert ana.color == ana2.color
        sync = ana2.ws.messages[0]
        assert sync["type"] == "sync"
        assert sync["you"]["color"] == ana.color
        peers = ana.ws.messages[-1]["peers"]
        assert {p["color"] for p in peers if p["user_id"] == "ana"} == {ana.color}
        await room.leave(ana)
        await room.leave(ana2)
        reconnected = connection("ana")
        await room.join(reconnected)
        assert reconnected.color == ana.color

    asyncio.run(scenario())


def test_paleta_agotada_no_repite_y_cada_tablero_asigna_independientemente():
    async def scenario():
        room = Room("many-users")
        for index in range(len(PALETTE) + 24):
            await room.join(connection(f"user-{index}"))
        colors = [p["color"] for p in room.presence()]
        assert len(set(colors)) == len(colors)
        assert all(len(color) == 7 and color.startswith("#") for color in colors)
        other = Room("other-board")
        conn = connection("user-1")
        await other.join(conn)
        assert conn.color == PALETTE[0]
        assert conn.color != room.user_colors["user-1"]

    asyncio.run(scenario())
