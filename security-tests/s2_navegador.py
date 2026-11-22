"""S2 · Reverse Proxy (P3): la web sigue funcionando detrás del gateway endurecido.

Recorre la aplicación en un navegador real (Chromium, Playwright) y mide:
  1. Violaciones de la Content-Security-Policy del gateway (evento securitypolicyviolation
     y consola) en la web SSR, el lienzo de Pizarra y la UI de Pixels (/pixels/).
  2. Peticiones HTTP simultáneas máximas desde una IP (lo que cuenta limit_conn: con HTTP/2
     cada stream en curso es una «conexión») y WebSocket abiertos a la vez (limit_conn conn_ws).
  3. Tasa pico contra la zona de limit_req «web» (páginas, RSC y BFF) en cualquier ventana de 1 s.
  4. Respuestas 429 (ningún flujo legítimo debe recibirlas).

    WEB_SSR_URL=https://localhost:8443 python security-tests/s2_navegador.py [--json salida.json]

Requisitos: pip install -r e2e/requirements.txt && python -m playwright install chromium.
Termina con código 1 si hay violaciones de CSP, algún 429 o falla un paso del recorrido.
"""

import argparse
import json
import os
import re
import sys
import time

from playwright.sync_api import expect, sync_playwright

WEB = os.getenv("WEB_SSR_URL", "https://localhost:8443").rstrip("/")
PASSWORD = "Password-demo-segura-123!"
# Rutas de la zona «web» del gateway (templates/snippets/web-routes.conf.template).
WEB_ZONE = re.compile(r"^/(?:|login|register|boards/[A-Za-z0-9_-]+|join/[A-Za-z0-9_-]+|session/expired|bff/.*)$")
CSP_LISTENER = """
window.__csp = [];
document.addEventListener('securitypolicyviolation', (e) => window.__csp.push({
  directiva: e.violatedDirective, bloqueado: e.blockedURI, origen: e.sourceFile, linea: e.lineNumber, modo: e.disposition }));
"""


class Monitor:
    """Cuenta peticiones en curso, WebSocket abiertos, tasa de la zona web y 429."""

    def __init__(self):
        self.inflight = 0
        self.max_inflight = 0
        self.ws_open = 0
        self.max_ws = 0
        self.web_times: list[float] = []
        self.status_429: list[str] = []
        self.requests = 0
        self.console_csp: list[str] = []

    def attach(self, page):
        page.on("request", self._start)
        page.on("requestfinished", self._end)
        page.on("requestfailed", self._end)
        page.on("response", self._response)
        page.on("websocket", self._ws)
        page.on("console", lambda m: self.console_csp.append(m.text) if "Content Security Policy" in m.text else None)

    def _start(self, req):
        self.requests += 1
        self.inflight += 1
        self.max_inflight = max(self.max_inflight, self.inflight)
        path = re.sub(r"^https?://[^/]+", "", req.url).split("?")[0]
        if WEB_ZONE.match(path):
            self.web_times.append(time.monotonic())

    def _end(self, _req):
        self.inflight = max(0, self.inflight - 1)

    def _response(self, res):
        if res.status == 429:
            self.status_429.append(res.url)

    def _ws(self, ws):
        self.ws_open += 1
        self.max_ws = max(self.max_ws, self.ws_open)
        ws.on("close", lambda _ws: setattr(self, "ws_open", max(0, self.ws_open - 1)))

    def peak_web_rate(self) -> int:
        t = sorted(self.web_times)
        best, j = 0, 0
        for i, start in enumerate(t):
            while t[j] < start - 1.0:
                j += 1
            best = max(best, i - j + 1)
        return best


def violations(page) -> list:
    """Devuelve y vacía las violaciones acumuladas en la página."""
    try:
        return page.evaluate("(() => { const v = window.__csp || []; window.__csp = []; return v; })()")
    except Exception:  # noqa: BLE001 - la página pudo navegar
        return []


def unique(items: list[dict]) -> list[dict]:
    seen, out = set(), []
    for v in items:
        key = (v.get("directiva"), v.get("bloqueado"), v.get("modo"), v.get("paso"))
        if key not in seen:
            seen.add(key)
            out.append(v)
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", help="guarda las medidas en este archivo")
    args = ap.parse_args()
    steps: list[dict] = []
    csp: list[dict] = []
    mon = Monitor()

    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(viewport={"width": 1366, "height": 860}, locale="es-CO", ignore_https_errors=WEB.startswith("https://"))
        ctx.add_init_script(CSP_LISTENER)
        page = ctx.new_page()
        mon.attach(page)
        errors: list[str] = []
        page.on("pageerror", lambda e: errors.append(str(e)))

        def step(name, fn):
            t0 = time.monotonic()
            try:
                fn()
                ok, detail = True, ""
            except Exception as exc:  # noqa: BLE001
                ok, detail = False, str(exc).splitlines()[0][:200]
            csp.extend({**v, "paso": name} for v in violations(page))
            steps.append({"paso": name, "ok": ok, "s": round(time.monotonic() - t0, 2), "detalle": detail})
            print(f"{'OK  ' if ok else 'FAIL'} {name}{' — ' + detail if detail else ''}", flush=True)

        name = f"S2 Nav {os.urandom(3).hex()}"
        board = {}

        def register():
            page.goto(f"{WEB}/register")
            page.get_by_label("Nombre", exact=True).fill(name)
            page.get_by_label("Correo electrónico").fill(f"{os.urandom(6).hex()}@collaboard.test")
            page.locator("#register-password").fill(PASSWORD)
            page.get_by_label("Confirmar contraseña").fill(PASSWORD)
            page.get_by_role("button", name="Crear cuenta").click()
            expect(page.get_by_role("heading", name="Tus tableros")).to_be_visible(timeout=20000)

        def create_board():
            res = page.request.post(f"{WEB}/bff/api/boards", data={"name": "Tablero S2"}, headers={"Origin": WEB, "X-CollaBoard-Client": "web"})
            if res.status != 201:
                # Si la cabecera del cliente web tiene otro nombre, se crea desde la API con la cookie.
                res = page.request.post(f"{WEB}/api/boards", data={"name": "Tablero S2"})
            assert res.status == 201, f"crear tablero: {res.status} {res.text()[:120]}"
            board["id"] = res.json()["id"]
            page.goto(WEB)
            expect(page.get_by_role("link", name="Abrir Tablero S2")).to_be_visible(timeout=20000)

        def open_board_and_draw():
            with page.expect_websocket(lambda ws: "/ws/boards/" in ws.url, timeout=20000):
                page.goto(f"{WEB}/boards/{board['id']}")
            canvas = page.get_by_label("Lienzo colaborativo", exact=True)
            expect(canvas).to_be_visible(timeout=20000)
            box = canvas.bounding_box()
            x, y = box["x"] + box["width"] * 0.35, box["y"] + box["height"] * 0.45
            page.mouse.move(x, y)
            page.mouse.down()
            for i in range(1, 12):
                page.mouse.move(x + i * 18, y + i * 9)
            page.mouse.up()
            page.wait_for_timeout(3000)

        def pixels():
            frames = []
            with page.expect_websocket(lambda ws: "/ws/pixels" in ws.url, timeout=20000) as ws_info:
                with page.expect_response(lambda r: "/api/pixels/board" in r.url, timeout=20000) as board_res:
                    page.goto(f"{WEB}/pixels/")
            ws_info.value.on("framereceived", lambda f: frames.append(f))
            assert board_res.value.status == 200, f"/api/pixels/board {board_res.value.status}"
            expect(page.locator("canvas").first).to_be_visible(timeout=20000)
            # pixels-api difunde las estadísticas ANTES de suscribir al socket nuevo (ws.rs): un
            # único cliente no recibe nada. Un segundo WebSocket abierto desde la propia página
            # (también sujeto a la CSP: connect-src) provoca la difusión hacia el de la SPA.
            page.evaluate(
                "() => new Promise((ok, ko) => { const w = new WebSocket(location.origin.replace('https', 'wss') + '/ws/pixels');"
                " w.onopen = () => setTimeout(() => { w.close(); ok(); }, 500); w.onerror = () => ko(new Error('wss bloqueado')); })"
            )
            page.wait_for_timeout(1500)
            assert frames, "el WebSocket de Pixels (wss://…/ws/pixels) no recibió mensajes"

        def reload_dashboard_three_times():
            for _ in range(3):
                page.goto(WEB)
                expect(page.get_by_role("heading", name="Tus tableros")).to_be_visible(timeout=20000)

        step("registro desde la web (Server Action)", register)
        step("crear tablero y verlo en el dashboard", create_board)
        step("abrir el tablero (wss://…/ws/boards) y dibujar", open_board_and_draw)
        step("UI de Pixels en /pixels/ (fetch + wss://…/ws/pixels)", pixels)
        step("recargar el dashboard 3 veces", reload_dashboard_three_times)
        browser.close()

    # Bloqueantes = la CSP impidió algo (falla). Report-Only = solo reportado (esperado en /pixels/).
    csp = unique(csp)
    blocking = [v for v in csp if v.get("modo") != "report"]
    reported = [v for v in csp if v.get("modo") == "report"]
    console_blocking = sorted({m for m in mon.console_csp if "report-only" not in m.lower() and "[Report Only]" not in m})
    result = {
        "web": WEB,
        "pasos": steps,
        "csp_bloqueantes": blocking,
        "csp_solo_reportadas": reported,
        "csp_consola_bloqueantes": console_blocking,
        "errores_js": errors,
        "peticiones": mon.requests,
        "max_peticiones_simultaneas": mon.max_inflight,
        "max_websocket_abiertos": mon.max_ws,
        "pico_zona_web_en_1s": mon.peak_web_rate(),
        "respuestas_429": mon.status_429,
    }
    print(
        json.dumps(
            {
                **{k: v for k, v in result.items() if k not in ("pasos", "csp_solo_reportadas")},
                "csp_solo_reportadas": sorted({f"{v['directiva']} ← {re.sub(r'/s/inter/.*', '/s/inter/…', v['bloqueado'])}" for v in reported}),
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    if args.json:
        with open(args.json, "w", encoding="utf-8") as fh:
            json.dump(result, fh, ensure_ascii=False, indent=2)
    failed = any(not s["ok"] for s in steps) or blocking or console_blocking or mon.status_429
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
