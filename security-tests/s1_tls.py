"""Escenario S1 · Secure Channel: verifica que nada sensible viaje en claro.

    python security-tests/s1_tls.py                         # P3: https://localhost:8443
    python security-tests/s1_tls.py --base http://localhost:8088 --ca ""   # P2 (antes)

Solo usa la biblioteca estándar de Python (y Docker para la captura de red).
Comprueba, con la misma acción contra el P2 (antes) y el P3 (después):

  1. HTTP plano solo redirige (301) a HTTPS, también un POST de login.
  2. TLS 1.0 y 1.1 rechazados por el gateway; 1.2 admitido; 1.3 por defecto.
  3. El certificado verifica contra la CA de desarrollo y el nombre del host.
  4. Cabecera Strict-Transport-Security.
  5. Login real por el formulario de la web (sin JavaScript): la cookie de
     sesión llega con Secure, HttpOnly y SameSite.
  6. WebSocket por wss:// (Pixels y Chat con la cookie de sesión): 101.
  7. Captura de red en la interfaz del gateway durante el login, la creación
     de un tablero y un mensaje de chat: 0 apariciones del correo, la
     contraseña, el JWT y el texto del mensaje.

Imprime OK/FAIL por comprobación y termina con código 1 si alguna falla.
--evidence DIR guarda la captura (.pcap) y un resumen para el informe.
"""

import argparse
import base64
import html.parser
import http.client
import json
import os
import pathlib
import secrets
import socket
import ssl
import subprocess
import sys
import time
import urllib.parse
import warnings

FAILS = []
# TLS 1.0/1.1 se ofrecen a propósito para comprobar que el gateway los rechaza.
warnings.filterwarnings("ignore", category=DeprecationWarning, message="ssl.TLSVersion")


def report(ok, name, detail=""):
    if not ok:
        FAILS.append(name)
    print(f"{'OK  ' if ok else 'FAIL'} {name}{' — ' + detail if detail else ''}", flush=True)


def tls_context(ca):
    ctx = ssl.create_default_context(cafile=ca) if ca else ssl.create_default_context()
    return ctx


def connection(url, ca, timeout=10):
    u = urllib.parse.urlsplit(url)
    if u.scheme == "https":
        return http.client.HTTPSConnection(u.hostname, u.port or 443, timeout=timeout, context=tls_context(ca))
    return http.client.HTTPConnection(u.hostname, u.port or 80, timeout=timeout)


def request(base, ca, method, path, body=None, headers=None):
    conn = connection(base, ca)
    try:
        conn.request(method, path, body=body, headers=headers or {})
        res = conn.getresponse()
        return res.status, res.getheaders(), res.read()
    finally:
        conn.close()


def header(headers, name):
    return [v for k, v in headers if k.lower() == name.lower()]


class FormInputs(html.parser.HTMLParser):
    """Campos del formulario de login tal como los enviaría un navegador sin JavaScript."""

    def __init__(self):
        super().__init__()
        self.forms, self._current = [], None

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "form":
            self._current = {"action": a.get("action") or "", "fields": []}
            self.forms.append(self._current)
        elif self._current is not None and a.get("name") and (tag == "input" or (tag == "button" and a.get("type") == "submit")):
            self._current["fields"].append((a["name"], a.get("value") or ""))

    def handle_endtag(self, tag):
        if tag == "form":
            self._current = None


def multipart(fields):
    boundary = "----s1" + secrets.token_hex(8)
    parts = []
    for name, value in fields:
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n')
    parts.append(f"--{boundary}--\r\n")
    return "".join(parts).encode(), f"multipart/form-data; boundary={boundary}"


def check_redirect(http_url, https_url):
    for method, path in (("GET", "/login"), ("POST", "/api/auth/login")):
        try:
            status, headers, _ = request(
                http_url,
                None,
                method,
                path,
                body=b"{}" if method == "POST" else None,
                headers={"Content-Type": "application/json"} if method == "POST" else {},
            )
        except OSError as exc:
            report(False, f"HTTP {method} {path} redirige a HTTPS", str(exc))
            continue
        location = (header(headers, "Location") or [""])[0]
        report(
            status == 301 and location == https_url + path,
            f"HTTP {method} {path} redirige a HTTPS",
            f"{status} → {location or 'sin Location'}",
        )


def tls_handshake(host, port, ca, version=None, verify=True):
    ctx = tls_context(ca) if verify else ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    if not verify:
        ctx.check_hostname, ctx.verify_mode = False, ssl.CERT_NONE
    if version:
        ctx.minimum_version = ctx.maximum_version = version
        # SECLEVEL=0: el CLIENTE puede ofrecer TLS 1.0/1.1, así el rechazo es del servidor.
        ctx.set_ciphers("DEFAULT@SECLEVEL=0")
    with socket.create_connection((host, port), timeout=5) as raw, ctx.wrap_socket(raw, server_hostname=host) as tls:
        return tls.version(), tls.cipher()[0]


def check_tls(base, ca):
    u = urllib.parse.urlsplit(base)
    if u.scheme != "https":
        report(False, "el sistema ofrece HTTPS", f"la entrada pública es {base}")
        return
    host, port = u.hostname, u.port or 443
    try:
        version, cipher = tls_handshake(host, port, ca)
        report(version == "TLSv1.3", "TLS 1.3 negociado y certificado válido para el host", f"{version} {cipher}")
    except (OSError, ssl.SSLError) as exc:
        report(False, "TLS 1.3 negociado y certificado válido para el host", str(exc))
    try:
        version, cipher = tls_handshake(host, port, ca, ssl.TLSVersion.TLSv1_2)
        report(version == "TLSv1.2", "TLS 1.2 admitido (clientes antiguos)", f"{version} {cipher}")
    except (OSError, ssl.SSLError) as exc:
        report(False, "TLS 1.2 admitido (clientes antiguos)", str(exc))
    for label, version in (("TLS 1.0", ssl.TLSVersion.TLSv1), ("TLS 1.1", ssl.TLSVersion.TLSv1_1)):
        try:
            got, _ = tls_handshake(host, port, ca, version, verify=False)
            report(False, f"{label} rechazado por el gateway", f"se negoció {got}")
        except ssl.SSLError as exc:
            reason = getattr(exc, "reason", "") or str(exc)
            rejected = any(k in reason.upper() for k in ("PROTOCOL_VERSION", "UNSUPPORTED_PROTOCOL"))
            report(rejected, f"{label} rechazado por el gateway", reason)
        except OSError as exc:
            report(False, f"{label} rechazado por el gateway", str(exc))


def check_hsts(base, ca):
    try:
        status, headers, _ = request(base, ca, "GET", "/login")
    except OSError as exc:
        report(False, "cabecera Strict-Transport-Security", str(exc))
        return
    hsts = header(headers, "Strict-Transport-Security")
    report(
        bool(hsts) and hsts[0].startswith("max-age="),
        "cabecera Strict-Transport-Security",
        hsts[0] if hsts else f"ausente (HTTP {status})",
    )


def api_json(base, ca, method, path, payload=None, token=None):
    headers = {"Content-Type": "application/json", "Origin": base}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    status, _, body = request(base, ca, method, path, json.dumps(payload).encode() if payload is not None else None, headers)
    return status, json.loads(body or b"{}")


def login_with_form(base, ca, email, password):
    """GET /login y POST del formulario (Server Action sin JavaScript). Devuelve Set-Cookie de la sesión."""
    status, _, body = request(base, ca, "GET", "/login")
    parser = FormInputs()
    parser.feed(body.decode("utf-8", "replace"))
    form = next((f for f in parser.forms if any(n == "email" for n, _ in f["fields"])), None)
    if status != 200 or form is None:
        return None, f"sin formulario de login (HTTP {status})"
    fields = [(n, email if n == "email" else password if n == "password" else v) for n, v in form["fields"]]
    data, ctype = multipart(fields)
    host = urllib.parse.urlsplit(base).netloc
    status, headers, _ = request(
        base, ca, "POST", form["action"] or "/login", data, {"Content-Type": ctype, "Origin": base, "Host": host}
    )
    cookie = next((c for c in header(headers, "Set-Cookie") if c.startswith("cb_session=")), None)
    return cookie, f"HTTP {status}"


def check_cookie(cookie, detail):
    if cookie is None:
        report(False, "login por la web: cookie de sesión Secure; HttpOnly; SameSite", detail)
        return
    attrs = {a.strip().split("=")[0].lower(): a.strip() for a in cookie.split(";")[1:]}
    ok = "secure" in attrs and "httponly" in attrs and "samesite" in attrs
    shown = "; ".join(v for k, v in attrs.items() if k in ("secure", "httponly", "samesite")) or "sin atributos"
    report(ok, "login por la web: cookie de sesión Secure; HttpOnly; SameSite", shown)


def ws_handshake(base, ca, path, headers):
    u = urllib.parse.urlsplit(base)
    port = u.port or (443 if u.scheme == "https" else 80)
    raw = socket.create_connection((u.hostname, port), timeout=5)
    sock = tls_context(ca).wrap_socket(raw, server_hostname=u.hostname) if u.scheme == "https" else raw
    key = base64.b64encode(secrets.token_bytes(16)).decode()
    lines = [
        f"GET {path} HTTP/1.1",
        f"Host: {u.netloc}",
        "Upgrade: websocket",
        "Connection: Upgrade",
        f"Sec-WebSocket-Key: {key}",
        "Sec-WebSocket-Version: 13",
    ] + [f"{k}: {v}" for k, v in headers.items()]
    with sock:
        sock.sendall(("\r\n".join(lines) + "\r\n\r\n").encode())
        status_line = sock.recv(4096).split(b"\r\n", 1)[0].decode(errors="replace")
    return status_line


def check_wss(base, ca, token, board_id):
    scheme = "wss" if base.startswith("https") else "ws"
    cases = [("/ws/pixels", {}, "Pixels")]
    if token and board_id:
        cases.append((f"/ws/chat/boards/{board_id}", {"Cookie": f"cb_session={token}", "Origin": base}, "Chat con cookie"))
    for path, headers, name in cases:
        try:
            line = ws_handshake(base, ca, path, headers)
            report(scheme == "wss" and " 101 " in line + " ", f"WebSocket {name} por wss://", f"{scheme}:// → {line}")
        except (OSError, ssl.SSLError) as exc:
            report(False, f"WebSocket {name} por wss://", str(exc))


class Capture:
    """tcpdump en el espacio de red del borde público (nicolaka/netshoot): ve lo mismo que un sniffer en la LAN."""

    def __init__(self, container, out_dir, bpf="tcp port 443"):
        self.container, self.dir, self.bpf, self.name = container, out_dir, bpf, "s1-captura-" + secrets.token_hex(3)

    def __enter__(self):
        self.dir.mkdir(parents=True, exist_ok=True)
        (self.dir / "s1.pcap").unlink(missing_ok=True)
        subprocess.run(
            [
                "docker",
                "run",
                "-d",
                "--rm",
                "--name",
                self.name,
                "--network",
                f"container:{self.container}",
                # -Z root: tcpdump no cambia de usuario, así puede escribir en la carpeta montada (Linux).
                "-v",
                f"{self.dir.resolve()}:/cap",
                "nicolaka/netshoot",
                "tcpdump",
                "-Z",
                "root",
                "-i",
                "any",
                "-U",
                "-s",
                "0",
                "-w",
                "/cap/s1.pcap",
                self.bpf,
            ],
            check=True,
            capture_output=True,
        )
        for _ in range(50):
            if (self.dir / "s1.pcap").exists():
                break
            time.sleep(0.2)
        time.sleep(1)
        return self

    def __exit__(self, *exc):
        time.sleep(1)
        subprocess.run(["docker", "stop", "-t", "2", self.name], check=False, capture_output=True)
        return False

    def read(self):
        return (self.dir / "s1.pcap").read_bytes()


def gateway_container():
    for svc in ("reverse-proxy", "gateway"):
        out = subprocess.run(["docker", "compose", "ps", "-q", svc], check=False, capture_output=True, text=True)
        if out.returncode == 0 and out.stdout.strip():
            return out.stdout.strip().splitlines()[0]
    return ""


def main():
    sys.stdout.reconfigure(encoding="utf-8")  # consola de Windows
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--base", default=os.getenv("S1_BASE", "https://localhost:8443"), help="entrada pública del sistema")
    ap.add_argument("--http", default=os.getenv("S1_HTTP", "http://localhost:8088"), help="puerto HTTP del gateway")
    ap.add_argument("--ca", default=os.getenv("S1_CA", "gateway/certs/ca.crt"), help="CA de desarrollo ('' = la del sistema)")
    ap.add_argument("--gateway", default=os.getenv("S1_GATEWAY", ""), help="contenedor del gateway (por defecto el del compose)")
    ap.add_argument("--evidence", default="", help="carpeta donde guardar la captura y el resumen")
    args = ap.parse_args()
    base, ca = args.base.rstrip("/"), args.ca or None
    if ca and not pathlib.Path(ca).exists():
        report(False, "CA de desarrollo disponible", f"no existe {ca} (¿arrancó el gateway?)")
        ca = None
    print(f"S1 · Secure Channel contra {base}\n")

    if base.startswith("https"):
        check_redirect(args.http.rstrip("/"), base)
    else:
        report(False, "HTTP plano solo redirige a HTTPS", f"la entrada pública es {base}")
    check_tls(base, ca)
    check_hsts(base, ca)

    suffix = secrets.token_hex(4)
    email, password = f"s1-{suffix}@ejemplo.com", f"S1-Secreto-{suffix}-Clave!"
    marker = f"mensaje-confidencial-{suffix}"
    container = args.gateway or gateway_container()
    evidence = pathlib.Path(args.evidence or os.path.join(os.getenv("TMP", "/tmp"), "s1-evidencia"))

    def session_flow():
        status, data = api_json(
            base,
            ca,
            "POST",
            "/api/auth/register",
            {"name": f"S1 {suffix}", "email": email, "password": password, "confirm_password": password},
        )
        if status not in (200, 201):
            report(False, "registro de la cuenta de prueba", f"HTTP {status} {data}")
            return None, None, None
        cookie, detail = login_with_form(base, ca, email, password)
        token = cookie.split(";", 1)[0].split("=", 1)[1] if cookie else data.get("access_token")
        status, board = api_json(base, ca, "POST", "/api/boards", {"name": f"S1 {suffix}"}, token)
        board_id = board.get("id") if status == 201 else None
        sent = 0
        if board_id:
            sent, _ = api_json(
                base,
                ca,
                "POST",
                f"/api/chat/boards/{board_id}/messages",
                {"text": marker, "client_message_id": secrets.token_hex(8)},
                token,
            )
        # Si algo de esto fallara, "0 secretos en la captura" no probaría nada.
        report(
            bool(board_id) and sent == 201,
            "sesión de prueba completa (tablero y mensaje de chat creados)",
            f"tablero HTTP {status}, mensaje HTTP {sent}",
        )
        return cookie, detail, (token, board_id)

    if not container:
        report(False, "captura de red en el gateway", "no se encontró el contenedor del gateway (usa --gateway)")
        cookie, detail, ids = session_flow()
        captured = None
    else:
        bpf = "tcp port 443" if base.startswith("https") else "tcp port 80"
        with Capture(container, evidence, bpf=bpf) as cap:
            cookie, detail, ids = session_flow()
        captured = cap.read()

    check_cookie(cookie, detail)
    token, board_id = ids or (None, None)
    check_wss(base, ca, token, board_id)

    if captured is not None:
        secrets_seen = {"correo": email, "contraseña": password, "JWT de sesión": token or "", "mensaje de chat": marker}
        found = {k: captured.count(v.encode()) for k, v in secrets_seen.items() if v}
        total = sum(found.values())
        detail = ", ".join(f"{k}: {n}" for k, n in found.items()) + f" (captura de {len(captured)} bytes)"
        report(total == 0 and len(captured) > 24, "captura de red: 0 secretos legibles", detail)
        summary = {"base": base, "bytes_capturados": len(captured), "apariciones": found, "fallos": FAILS}
        (evidence / "s1-resumen.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"\nCaptura y resumen en {evidence}")

    print(f"\n{'Todas las comprobaciones OK' if not FAILS else f'{len(FAILS)} comprobaciones fallaron'}")
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(main())
