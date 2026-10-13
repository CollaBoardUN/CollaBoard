"""Prueba de punta a punta del entregable de la Persona 1.

"Un usuario autenticado crea un tablero, lo comparte y otro entra con el rol correcto."

Requiere Pizarra, Auth Go (AUTH_DEV_MODE=false) y frontend corriendo:
    WEB_URL=http://localhost:5173 pytest e2e
"""

import os
import re

import pytest
from playwright.sync_api import Browser, Page, expect, sync_playwright

WEB = os.getenv("WEB_URL", "http://localhost:5173").rstrip("/")


@pytest.fixture(scope="module")
def browser():
    with sync_playwright() as p:
        exe = os.getenv("CHROME_PATH") or None
        b = p.chromium.launch(executable_path=exe)
        yield b
        b.close()


def register(page: Page, name: str) -> None:
    page.get_by_role("link", name="Regístrate").click()
    page.get_by_label("Nombre", exact=True).fill(name)
    page.get_by_label("Correo electrónico").fill(f"{os.urandom(8).hex()}@example.com")
    page.locator("#register-password").fill("Password-demo-segura-123!")
    page.get_by_label("Confirmar contraseña").fill("Password-demo-segura-123!")
    page.get_by_role("button", name="Crear cuenta").click()
    expect(page.get_by_role("button", name="Crear cuenta")).to_have_count(0)


def new_page(browser: Browser, errors: list, width: int = 1280, **kw) -> Page:
    ctx = browser.new_context(viewport={"width": width, "height": 820}, **kw)
    page = ctx.new_page()
    page.on("pageerror", lambda e: errors.append(str(e)))
    return page


def test_flujo_completo(browser: Browser):
    errors: list[str] = []
    sufijo = os.urandom(3).hex()  # nombres únicos: la prueba se puede repetir
    ana_nombre, beto_nombre = f"Ana {sufijo}", f"Beto {sufijo}"
    tablero = f"Ideas {sufijo}"
    otro = f"Privado {sufijo}"

    # Ana entra y crea dos tableros
    ana = new_page(browser, errors, permissions=["clipboard-read", "clipboard-write"])
    ana.goto(WEB)
    register(ana, ana_nombre)
    for nombre in (otro, tablero):
        ana.goto(WEB)
        ana.get_by_role("button", name="Nuevo tablero").click()
        ana.get_by_label("Nombre").fill(nombre)
        ana.get_by_role("button", name="Crear tablero").click()
        expect(ana.get_by_role("button", name=nombre)).to_be_visible()
    url_tablero = ana.url

    # Comparte con un link de solo lectura
    ana.get_by_role("button", name="Compartir").click()
    ana.get_by_text("Solo ver").first.click()
    ana.get_by_role("button", name="Crear y copiar link").click()
    link = ana.get_by_label("Link de invitación", exact=True)
    expect(link).to_have_value(re.compile(r"/join/"))
    link_viewer = link.input_value()

    # Y otro de edición
    ana.get_by_text("Puede editar").first.click()
    ana.get_by_role("button", name="Crear y copiar link").click()
    expect(link).not_to_have_value(link_viewer)
    link_editor = link.input_value()
    ana.keyboard.press("Escape")

    # Beto abre el link sin sesión: login y vuelve a la invitación
    beto = new_page(browser, errors)
    beto.goto(link_viewer)
    register(beto, beto_nombre)
    expect(beto.get_by_text(tablero)).to_be_visible()
    beto.get_by_role("button", name="Unirme al tablero").click()
    expect(beto.get_by_text("Estás en modo solo lectura")).to_be_visible()
    expect(beto.get_by_role("button", name="Compartir")).to_have_count(0)

    # Con el link de editor sube de permiso
    beto.goto(link_editor)
    beto.get_by_role("button", name="Obtener permiso de edición").click()
    expect(beto.get_by_text("Tienes permiso para dibujar")).to_be_visible()

    # No ve el tablero al que no lo invitaron
    ana.goto(WEB)
    href = ana.get_by_role("link", name=f"Abrir {otro}").get_attribute("href")
    beto.goto(WEB + href)
    expect(beto.get_by_text("No encontramos este tablero")).to_be_visible()

    # Ana lo baja a "Solo ver"
    ana.goto(url_tablero)
    ana.get_by_role("button", name="Compartir").click()
    ana.get_by_label(f"Permiso de {beto_nombre}").select_option("viewer")
    expect(ana.get_by_text(f"{beto_nombre} ahora: solo ver")).to_be_visible()
    ana.keyboard.press("Escape")

    beto.goto(url_tablero)
    expect(beto.get_by_text("Estás en modo solo lectura")).to_be_visible()

    # Beto se sale; Ana borra el tablero
    beto.goto(WEB)
    beto.get_by_role("button", name=f"Opciones de {tablero}").click()
    beto.get_by_role("menuitem", name="Salir del tablero").click()
    beto.get_by_role("button", name="Salir del tablero").click()
    expect(beto.get_by_text(tablero)).to_have_count(0)

    ana.goto(WEB)
    ana.get_by_role("button", name=f"Opciones de {tablero}").click()
    ana.get_by_role("menuitem", name="Borrar tablero").click()
    ana.get_by_role("button", name="Borrar tablero").click()
    expect(ana.get_by_text(tablero)).to_have_count(0)

    # El link ya no sirve
    beto.goto(link_editor)
    expect(beto.get_by_text("Este link no funciona")).to_be_visible()

    assert errors == []


def test_movil_sin_scroll_horizontal(browser: Browser):
    errors: list[str] = []
    page = new_page(browser, errors, width=390)
    page.goto(WEB)
    register(page, f"Móvil {os.urandom(2).hex()}")
    page.get_by_role("button", name="Crear mi primer tablero").click()
    page.get_by_label("Nombre").fill("Tablero desde el celular")
    page.get_by_role("button", name="Crear tablero").click()
    page.get_by_role("button", name="Compartir").click()
    expect(page.get_by_role("button", name="Crear y copiar link")).to_be_visible()
    assert page.evaluate("document.documentElement.scrollWidth") <= 390
    assert errors == []
