"""El WebSocket de dibujo pertenece a Pizarra; su suite está en ese módulo."""


def test_colaboracion_no_publica_websocket_de_pizarra():
    from app.main import app

    assert not any(getattr(route, "path", "").startswith("/ws/") for route in app.routes)
