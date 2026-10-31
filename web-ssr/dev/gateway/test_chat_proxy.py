"""Regresión del handshake de Chat a través de la configuración REAL de Nginx.

Desde la raíz: python web-ssr/dev/gateway/test_chat_proxy.py
Requiere Docker Linux. Crea solo una red y contenedores de prueba desechables,
sin conectar el stack, usar credenciales reales ni enviar mensajes de usuarios.
"""
import base64
import hashlib
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import subprocess
import sys
import threading
import time
import unittest
import uuid


class Upstream(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def do_GET(self):
        self.rfile.read(int(self.headers.get("Content-Length", "0")))
        observed = {
            "host": self.headers.get("Host"),
            "request_id": self.headers.get("X-Request-Id"),
            "forwarded_host": self.headers.get("X-Forwarded-Host"),
            "cookie": self.headers.get("Cookie") == "cb_session=proxy-test-only",
            "bearer": self.headers.get("Authorization") == "Bearer proxy-test-only",
        }
        if self.headers.get("Upgrade", "").lower() == "websocket":
            accept = hashlib.sha1((self.headers["Sec-WebSocket-Key"] +
                                   "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()
            self.send_response(101)
            self.send_header("Upgrade", "websocket")
            self.send_header("Connection", "Upgrade")
            self.send_header("Sec-WebSocket-Accept", base64.b64encode(accept).decode())
            for key, value in observed.items():
                self.send_header("X-Probe-" + key.replace("_", "-"), str(value))
            self.end_headers()
            self.close_connection = True
        else:
            data = json.dumps(observed).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

    do_POST = do_GET


def fixture():
    # Todos los upstreams resuelven aquí, sin acceder a servicios/datos reales.
    for port in (3000, 8000, 8001, 4100, 8090):
        server = ThreadingHTTPServer(("0.0.0.0", port), Upstream)
        threading.Thread(target=server.serve_forever, daemon=True).start()
    threading.Event().wait()


def docker(*args):
    return subprocess.run(["docker", *args], check=True, capture_output=True, text=True).stdout.strip()


class ChatProxyTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        suffix = uuid.uuid4().hex[:10]
        network = "chat-proxy-test-" + suffix
        upstream, proxy = network + "-upstream", network + "-nginx"
        docker("network", "create", network)
        cls.addClassCleanup(lambda: docker("network", "rm", network))
        source = Path(__file__).resolve()
        aliases = ["web-ssr", "authentication-backend", "colaboracion-backend",
                   "pizarra-backend", "pixels-backend", "dev-mocks", "chat-api"]
        alias_args = [arg for alias in aliases for arg in ("--network-alias", alias)]
        docker("run", "-d", "--name", upstream, "--network", network, *alias_args,
               "--mount", f"type=bind,source={source},target=/test.py,readonly",
               "python:3.12-alpine", "python", "/test.py", "--upstream")
        cls.addClassCleanup(lambda: docker("rm", "-f", upstream))
        docker("run", "-d", "--name", proxy, "--network", network,
               "-p", "127.0.0.1::80", "--mount",
               f"type=bind,source={source.with_name('nginx.conf')},target=/etc/nginx/conf.d/default.conf,readonly",
               "nginx:1.27-alpine")
        cls.addClassCleanup(lambda: docker("rm", "-f", proxy))
        cls.port = int(docker("port", proxy, "80/tcp").rsplit(":", 1)[1])
        deadline = time.monotonic() + 20
        while True:
            try:
                connection, response = cls.request("/healthz")
                ready = response.status == 200
                response.read()
                connection.close()
                if ready:
                    break
            except (OSError, http.client.HTTPException):
                pass
            if time.monotonic() >= deadline:
                raise AssertionError("El proxy de prueba no arrancó")
            time.sleep(0.1)

    @classmethod
    def request(cls, path, extra=None):
        connection = http.client.HTTPConnection("127.0.0.1", cls.port, timeout=3)
        connection.request("GET", path, headers={
            "Host": "localhost:8088", "X-Request-Id": "chat-proxy-regression", **(extra or {}),
        })
        return connection, connection.getresponse()

    def upgrade(self, credentials):
        connection, response = self.request("/ws/chat/boards/test-board", {
            "Upgrade": "websocket", "Connection": "Upgrade", "Sec-WebSocket-Version": "13",
            "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==", **credentials,
        })
        self.addCleanup(connection.close)
        self.assertEqual(response.status, 101)
        self.assertEqual(response.getheader("X-Probe-Host"), "localhost:8088")
        self.assertEqual(response.getheader("X-Probe-Forwarded-Host"), "localhost:8088")
        self.assertEqual(response.getheader("X-Probe-Request-Id"), "chat-proxy-regression")
        return response

    def test_browser_upgrade_preserves_host_cookie_and_correlation(self):
        response = self.upgrade({"Origin": "http://localhost:8088", "Cookie": "cb_session=proxy-test-only"})
        self.assertEqual(response.getheader("X-Probe-Cookie"), "True")

    def test_electron_upgrade_preserves_bearer(self):
        response = self.upgrade({"Authorization": "Bearer proxy-test-only"})
        self.assertEqual(response.getheader("X-Probe-Bearer"), "True")

    def test_http_route_keeps_inherited_headers(self):
        connection, response = self.request("/api/chat/boards/test-board/messages")
        self.addCleanup(connection.close)
        self.assertEqual(response.status, 200)
        body = json.loads(response.read())
        self.assertEqual(body["host"], "localhost:8088")
        self.assertEqual(body["request_id"], "chat-proxy-regression")


if __name__ == "__main__":
    if "--upstream" in sys.argv:
        fixture()
    else:
        unittest.main()
