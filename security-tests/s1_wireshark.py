"""Escenario S1 con Wireshark: una persona usa la web en un navegador real mientras
Wireshark (dumpcap) captura en la interfaz de loopback del equipo.

    python security-tests/s1_wireshark.py --base http://localhost:8088 --out docs/p3/evidencia/S1/wireshark/antes
    python security-tests/s1_wireshark.py --base https://localhost:8443 --out docs/p3/evidencia/S1/wireshark/despues

Requiere Wireshark (dumpcap y tshark; en Windows con Npcap y su "Adapter for loopback
traffic capture") y Playwright (pip install -r e2e/requirements.txt).

El navegador (Chromium) se registra, cierra sesión, inicia sesión por el formulario,
crea un tablero, dibuja y escribe en el chat. Luego tshark (el motor de Wireshark)
disecciona la captura y cuenta cuántas veces aparecen el correo, la contraseña, el JWT
de la sesión y el mensaje (en texto o en hexadecimal):

  - sin llaves: lo que ve un atacante en la red (debe ser 0 con HTTPS);
  - con las llaves de sesión TLS que exportó el navegador (SSLKEYLOGFILE): prueba
    que la captura sí contiene esa sesión y que lo único que la protege es el cifrado.

Deja en --out: captura.pcapng, llaves-tls.log (solo con HTTPS), resumen.json y vista
de los paquetes relevantes en texto. Para verlo en la interfaz de Wireshark, ver
docs/p3/evidencia/S1/wireshark/README.md.
"""

import argparse
import json
import os
import pathlib
import secrets
import shutil
import signal
import subprocess
import sys
import time
import urllib.parse

from playwright.sync_api import expect, sync_playwright

WINDOWS = os.name == "nt"


def wireshark_tool(name, folder):
    exe = name + (".exe" if WINDOWS else "")
    candidate = pathlib.Path(folder) / exe if folder else None
    if candidate and candidate.exists():
        return str(candidate)
    found = shutil.which(name)
    if not found:
        sys.exit(f"No se encontró {name} de Wireshark (usa --wireshark-dir)")
    return found


def tshark_text(tshark, pcap, keylog, *args):
    cmd = [tshark, "-r", str(pcap)]
    if keylog:
        cmd += ["-o", f"tls.keylog_file:{keylog}"]
    out = subprocess.run(cmd + list(args), check=False, capture_output=True, text=True, encoding="utf-8", errors="replace")
    return out.stdout


def occurrences(text, value):
    """Apariciones del valor en texto o en el volcado hexadecimal de tshark."""
    if not value:
        return 0
    hexed = value.encode().hex()
    return text.count(value) + text.lower().replace(":", "").count(hexed)


def browse(base, email, password, marker, keylog, headed):
    """Recorrido real en Chromium. Devuelve el JWT de la cookie de sesión."""
    env = dict(os.environ)
    if keylog:
        env["SSLKEYLOGFILE"] = str(keylog)  # Chromium exporta aquí los secretos de cada sesión TLS
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=not headed, env=env, executable_path=os.getenv("CHROME_PATH") or None)
        ctx = browser.new_context(ignore_https_errors=True, locale="es-CO", viewport={"width": 1366, "height": 860})
        page = ctx.new_page()
        page.goto(base)
        page.get_by_role("link", name="Regístrate").click()
        page.get_by_label("Nombre", exact=True).fill("Víctima S1")
        page.get_by_label("Correo electrónico").fill(email)
        page.locator("#register-password").fill(password)
        page.get_by_label("Confirmar contraseña").fill(password)
        page.get_by_role("button", name="Crear cuenta").click()
        expect(page.get_by_role("heading", name="Tus tableros")).to_be_visible()
        page.get_by_role("button", name="Cerrar sesión").click()
        page.locator("#login-email").fill(email)
        page.locator("#login-password").fill(password)
        page.get_by_role("button", name="Iniciar sesión").click()
        expect(page.get_by_role("heading", name="Tus tableros")).to_be_visible()
        token = next(c["value"] for c in ctx.cookies() if c["name"] == "cb_session")
        page.get_by_role("button", name="Nuevo tablero").click()
        page.get_by_label("Nombre").fill("Tablero S1")
        page.get_by_role("button", name="Crear tablero").click()
        expect(page.get_by_role("status").filter(has_text="En línea")).to_be_visible()
        canvas = page.get_by_label("Lienzo colaborativo", exact=True)
        box = canvas.bounding_box()
        page.mouse.move(box["x"] + box["width"] * 0.3, box["y"] + box["height"] * 0.4)
        page.mouse.down()
        for step in range(1, 10):
            page.mouse.move(box["x"] + box["width"] * 0.3 + step * 20, box["y"] + box["height"] * 0.4 + step * 8)
        page.mouse.up()
        page.get_by_role("button", name="Chat").click()
        page.get_by_label("Escribe un mensaje").fill(marker)
        page.keyboard.press("Enter")
        expect(page.get_by_role("log").get_by_text(marker)).to_be_visible()
        page.wait_for_timeout(1500)
        browser.close()
    return token


def main():
    sys.stdout.reconfigure(encoding="utf-8")  # consola de Windows
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--base", default="https://localhost:8443", help="URL que abre el navegador")
    ap.add_argument("--http-port", type=int, default=8088, help="puerto HTTP del gateway (también se captura)")
    ap.add_argument("--out", required=True, help="carpeta de evidencia")
    ap.add_argument("--iface", default=r"\Device\NPF_Loopback" if WINDOWS else "lo", help="interfaz de captura")
    ap.add_argument("--wireshark-dir", default=r"C:\Program Files\Wireshark" if WINDOWS else "", help="carpeta de Wireshark")
    ap.add_argument("--headed", action="store_true", help="mostrar el navegador (demo en vivo)")
    args = ap.parse_args()

    out = pathlib.Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    dumpcap = wireshark_tool("dumpcap", args.wireshark_dir)
    tshark = wireshark_tool("tshark", args.wireshark_dir)
    https = args.base.startswith("https")
    port = urllib.parse.urlsplit(args.base).port or (443 if https else 80)
    pcap, keylog = out / "captura.pcapng", (out / "llaves-tls.log" if https else None)
    for f in (pcap, keylog):
        if f:
            f.unlink(missing_ok=True)

    suffix = secrets.token_hex(4)
    email, password, marker = f"victima-{suffix}@ejemplo.com", f"S1-Clave-{suffix}!", f"mensaje-confidencial-{suffix}"

    print(f"Capturando con Wireshark (dumpcap) en {args.iface}, puertos {port} y {args.http_port}…", flush=True)
    capture = subprocess.Popen(
        [dumpcap, "-q", "-i", args.iface, "-f", f"tcp port {port} or tcp port {args.http_port}", "-w", str(pcap)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if WINDOWS else 0,
    )
    for _ in range(50):
        if pcap.exists():
            break
        time.sleep(0.2)
    time.sleep(1)
    try:
        token = browse(args.base, email, password, marker, keylog, args.headed)
    finally:
        time.sleep(1)
        capture.send_signal(signal.CTRL_BREAK_EVENT if WINDOWS else signal.SIGINT)
        try:
            capture.wait(timeout=10)
        except subprocess.TimeoutExpired:
            capture.kill()

    secrets_seen = {"correo": email, "contraseña": password, "JWT de sesión": token, "mensaje de chat": marker}
    views = {"sin llaves (atacante)": None}
    if keylog and keylog.exists():
        views["con las llaves del navegador"] = keylog
    summary = {
        "base": args.base,
        "interfaz": args.iface,
        "captura": pcap.name,
        "protocolos": tshark_text(tshark, pcap, None, "-q", "-z", "io,phs").strip(),
        "apariciones": {},
    }
    for label, keys in views.items():
        # PDML: disección completa con los valores sin recortar (-V acorta los campos largos, como el JWT).
        dissection = tshark_text(tshark, pcap, keys, "-T", "pdml")
        summary["apariciones"][label] = {k: occurrences(dissection, v) for k, v in secrets_seen.items()}
    # Paquetes que alguien buscaría en Wireshark: peticiones de la aplicación (sin los
    # archivos estáticos /_next), saludos TLS y WebSocket.
    columns = ["-T", "fields", "-E", "separator=\t", "-e", "frame.number", "-e", "_ws.col.Protocol", "-e", "_ws.col.Info"]
    flt = (
        '((http.request or http2.headers.method or websocket) and !(http.request.uri contains "/_next")'
        ' and !(http2.headers.path contains "/_next")) or tls.handshake.type == 1 or tls.handshake.type == 2'
    )
    (out / "paquetes-sin-llaves.txt").write_text(tshark_text(tshark, pcap, None, "-Y", flt, *columns), encoding="utf-8")
    if keylog:
        (out / "paquetes-con-llaves.txt").write_text(tshark_text(tshark, pcap, keylog, "-Y", flt, *columns), encoding="utf-8")
    (out / "resumen.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")

    print(summary["protocolos"], "\n")
    failures = 0
    attacker = summary["apariciones"]["sin llaves (atacante)"]
    total = sum(attacker.values())
    ok = https and total == 0
    failures += not ok
    print(f"{'OK  ' if ok else 'FAIL'} sin llaves (atacante): {', '.join(f'{k}: {n}' for k, n in attacker.items())}")
    if "con las llaves del navegador" in summary["apariciones"]:
        with_keys = summary["apariciones"]["con las llaves del navegador"]
        decrypted = with_keys["contraseña"] > 0 and with_keys["mensaje de chat"] > 0
        failures += not decrypted
        print(
            f"{'OK  ' if decrypted else 'FAIL'} con las llaves del navegador la misma captura sí contiene la sesión: "
            f"{', '.join(f'{k}: {n}' for k, n in with_keys.items())}"
        )
    print(f"\nEvidencia en {out}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
