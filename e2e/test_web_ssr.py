"""Pruebas de punta a punta de la web SSR (prototipo 2, paquete A).

Escenarios del plan P2 (sección 10) que cubre esta presentación:
  1. SSR real y privado: el HTML inicial trae los tableros del usuario sin
     ejecutar JavaScript, no trae datos de otra cuenta ni el JWT, y sin sesión
     no se entrega nada privado.
  2. Recorrido web: registrarse, crear, dibujar, compartir, unirse, conversar en
     vivo y recibir la notificación en la bandeja.
  3. Roles: quien solo ve no tiene herramientas de dibujo, pero sí chat.
  4. Cerrar sesión borra la cookie del servidor.

Requiere el stack con la web SSR detrás del gateway (Chat y Notificaciones
pueden ser los mocks de desarrollo):

    docker compose -f docker-compose.yml -f web-ssr/compose.dev.yml up --build -d
    WEB_SSR_URL=http://localhost:8088 pytest e2e/test_web_ssr.py -v
"""

import os
import re

import pytest
from playwright.sync_api import Browser, BrowserContext, Page, expect, sync_playwright

WEB = os.getenv("WEB_SSR_URL", "http://localhost:8088").rstrip("/")
PASSWORD = "Password-demo-segura-123!"
SESSION_COOKIE = "cb_session"


@pytest.fixture(scope="module")
def browser():
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path=os.getenv("CHROME_PATH") or None)
        yield b
        b.close()


def unique(prefix: str) -> str:
    return f"{prefix} {os.urandom(3).hex()}"


def new_context(browser: Browser, errors: list[str], **kw) -> BrowserContext:
    ctx = browser.new_context(viewport={"width": 1366, "height": 860}, locale="es-CO", **kw)
    ctx.on("page", lambda page: page.on("pageerror", lambda e: errors.append(str(e))))
    return ctx


def register_api(ctx: BrowserContext, name: str) -> str:
    """Registra por el gateway (Auth Go) y devuelve el JWT."""
    res = ctx.request.post(
        f"{WEB}/api/auth/register",
        data={
            "name": name,
            "email": f"{os.urandom(6).hex()}@collaboard.test",
            "password": PASSWORD,
            "confirm_password": PASSWORD,
        },
    )
    assert res.status == 201, res.text()
    return res.json()["access_token"]


def register_ui(page: Page, name: str) -> None:
    page.get_by_role("link", name="Regístrate").click()
    page.get_by_label("Nombre", exact=True).fill(name)
    page.get_by_label("Correo electrónico").fill(f"{os.urandom(6).hex()}@collaboard.test")
    page.locator("#register-password").fill(PASSWORD)
    page.get_by_label("Confirmar contraseña").fill(PASSWORD)
    page.get_by_role("button", name="Crear cuenta").click()
    expect(page.get_by_role("button", name="Crear cuenta")).to_have_count(0)


def create_board_api(ctx: BrowserContext, token: str, name: str) -> str:
    res = ctx.request.post(f"{WEB}/api/boards", data={"name": name}, headers={"Authorization": f"Bearer {token}"})
    assert res.status == 201, res.text()
    return res.json()["id"]


def with_session(ctx: BrowserContext, token: str) -> None:
    host = re.sub(r"^https?://", "", WEB).split("/")[0].split(":")[0]
    ctx.add_cookies([{"name": SESSION_COOKIE, "value": token, "domain": host, "path": "/", "httpOnly": True}])


def draw_stroke(page: Page) -> None:
    canvas = page.get_by_label("Lienzo colaborativo", exact=True)
    expect(canvas).to_be_visible()
    box = canvas.bounding_box()
    assert box
    x, y = box["x"] + box["width"] * 0.35, box["y"] + box["height"] * 0.45
    page.mouse.move(x, y)
    page.mouse.down()
    for step in range(1, 12):
        page.mouse.move(x + step * 18, y + step * 9)
    page.mouse.up()


def test_ssr_real_y_privado_sin_javascript(browser: Browser):
    errors: list[str] = []
    api = new_context(browser, errors)
    token_ana = register_api(api, unique("Ana"))
    token_beto = register_api(api, unique("Beto"))
    tablero_ana = unique("Plan secreto de Ana")
    tablero_beto = unique("Privado de Beto")
    board_id = create_board_api(api, token_ana, tablero_ana)
    create_board_api(api, token_beto, tablero_beto)

    # JavaScript desactivado: lo que se ve lo produjo el servidor.
    ana = new_context(browser, errors, java_script_enabled=False)
    with_session(ana, token_ana)
    page = ana.new_page()
    response = page.goto(WEB)
    assert response and response.status == 200
    assert "no-store" in (response.headers.get("cache-control") or "")
    html = page.content()
    assert tablero_ana in html
    assert tablero_beto not in html, "el HTML de Ana no puede traer datos de Beto"
    assert token_ana not in html and token_ana.split(".")[2] not in html, "el JWT no debe aparecer en el HTML"
    expect(page.get_by_role("link", name=f"Abrir {tablero_ana}")).to_be_visible()

    # La página del tablero también llega renderizada (nombre y rol).
    page.goto(f"{WEB}/boards/{board_id}")
    expect(page).to_have_title(re.compile(re.escape(tablero_ana)))
    expect(page.get_by_text("Dueño").first).to_be_visible()

    # Otra cuenta no obtiene el tablero; sin sesión se redirige al login.
    beto = new_context(browser, errors, java_script_enabled=False)
    with_session(beto, token_beto)
    other = beto.new_page()
    assert other.goto(f"{WEB}/boards/{board_id}").status == 404
    assert tablero_ana not in other.content()

    anon = new_context(browser, errors, java_script_enabled=False).new_page()
    anon.goto(f"{WEB}/boards/{board_id}")
    assert "/login" in anon.url
    assert tablero_ana not in anon.content()

    # Una cookie con un token falso no da acceso.
    forged = new_context(browser, errors, java_script_enabled=False)
    with_session(forged, token_ana.rsplit(".", 1)[0] + ".firma-falsa")
    page_forged = forged.new_page()
    page_forged.goto(WEB)
    assert "/login" in page_forged.url
    assert not [c for c in forged.cookies() if c["name"] == SESSION_COOKIE and c["value"]], "la cookie inválida se borra"


def test_recorrido_web_completo(browser: Browser):
    errors: list[str] = []
    ana_nombre, beto_nombre = unique("Ana"), unique("Beto")
    tablero = unique("Arquitectura")

    # Ana se registra desde la web (Server Action -> Auth Go -> cookie HttpOnly).
    ana_ctx = new_context(browser, errors, permissions=["clipboard-read", "clipboard-write"])
    ana = ana_ctx.new_page()
    ana.goto(WEB)
    expect(ana).to_have_url(re.compile(r"/login"))
    register_ui(ana, ana_nombre)
    expect(ana.get_by_role("heading", name="Tus tableros")).to_be_visible()
    cookie = next(c for c in ana_ctx.cookies() if c["name"] == SESSION_COOKIE)
    assert cookie["httpOnly"] and cookie["sameSite"] == "Lax"
    assert ana.evaluate("document.cookie").find(SESSION_COOKIE) == -1, "JavaScript no puede leer la sesión"

    # Crea un tablero (BFF) y dibuja (WebSocket de Pizarra por el gateway).
    ana.get_by_role("button", name="Nuevo tablero").click()
    ana.get_by_label("Nombre").fill(tablero)
    ana.get_by_role("button", name="Crear tablero").click()
    expect(ana.get_by_role("button", name=tablero)).to_be_visible()
    expect(ana.get_by_role("status").filter(has_text="En línea")).to_be_visible()
    draw_stroke(ana)
    expect(ana.get_by_role("status").filter(has_text="Guardado")).to_be_visible(timeout=15_000)

    # Comparte como editor.
    ana.get_by_role("button", name="Compartir").click()
    ana.get_by_text("Puede editar").first.click()
    ana.get_by_role("button", name="Crear y copiar link").click()
    link = ana.get_by_label("Link de invitación", exact=True)
    expect(link).to_have_value(re.compile(r"/join/"))
    invite = link.input_value()
    ana.keyboard.press("Escape")
    ana.get_by_role("button", name="Chat").click()
    expect(ana.get_by_role("status").filter(has_text="En vivo")).to_be_visible()

    # Beto abre el link sin sesión: se registra y vuelve a la invitación.
    beto_ctx = new_context(browser, errors)
    beto = beto_ctx.new_page()
    beto.goto(invite)
    expect(beto).to_have_url(re.compile(r"/login\?next=%2Fjoin%2F"))
    register_ui(beto, beto_nombre)
    expect(beto.get_by_role("heading", name=tablero)).to_be_visible()
    beto.get_by_role("button", name="Unirme al tablero").click()
    expect(beto.get_by_role("heading", name=tablero)).to_be_visible()

    # Beto ve el trazo guardado y conversa; Ana lo recibe en vivo.
    expect(beto.get_by_role("status").filter(has_text="En línea")).to_be_visible()
    beto.get_by_role("button", name="Chat").click()
    texto = f"Hola {ana_nombre}, ya estoy dentro"
    beto.get_by_label("Escribe un mensaje").fill(texto)
    beto.keyboard.press("Enter")
    expect(beto.get_by_role("log").get_by_text(texto)).to_be_visible()
    expect(ana.get_by_role("log").get_by_text(texto)).to_be_visible(timeout=10_000)

    # La bandeja de Ana recibe "Beto escribió en ..." (sondeo REST).
    bell = ana.get_by_role("button", name=re.compile(r"Notificaciones, \d+ sin leer"))
    expect(bell).to_be_visible(timeout=25_000)
    bell.click()
    expect(ana.get_by_text(f"{beto_nombre} escribió en {tablero}")).to_be_visible()

    assert not errors, f"errores de JavaScript: {errors}"


def test_roles_y_cierre_de_sesion(browser: Browser):
    errors: list[str] = []
    api = new_context(browser, errors)
    token_owner = register_api(api, unique("Dueña"))
    board_id = create_board_api(api, token_owner, unique("Solo lectura"))
    invite = api.request.post(
        f"{WEB}/api/boards/{board_id}/invite",
        data={"role": "viewer", "expires_in_hours": 24},
        headers={"Authorization": f"Bearer {token_owner}"},
    ).json()

    viewer_ctx = new_context(browser, errors)
    with_session(viewer_ctx, register_api(api, unique("Carla")))
    viewer = viewer_ctx.new_page()
    viewer.goto(f"{WEB}/join/{invite['token']}")
    viewer.get_by_role("button", name="Unirme al tablero").click()
    expect(viewer.get_by_role("note")).to_contain_text("solo lectura")
    expect(viewer.get_by_role("complementary", name="Herramientas del tablero")).to_have_count(0)
    expect(viewer.get_by_role("button", name="Chat")).to_be_visible()

    # Cerrar sesión borra la cookie en el servidor y protege las páginas.
    viewer.get_by_role("button", name="Cerrar sesión").click()
    expect(viewer).to_have_url(re.compile(r"/login"))
    assert not [c for c in viewer_ctx.cookies() if c["name"] == SESSION_COOKIE and c["value"]]
    viewer.goto(f"{WEB}/boards/{board_id}")
    expect(viewer).to_have_url(re.compile(r"/login"))
    assert not errors, f"errores de JavaScript: {errors}"
