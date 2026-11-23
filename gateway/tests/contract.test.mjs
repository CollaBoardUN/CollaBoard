// Contrato del gateway contra un upstream "eco": comprueba EXACTAMENTE qué recibe cada
// servicio (rutas reescritas, cabeceras sin tocar, token de Pizarra, X-Request-ID, bloqueos)
// y el canal seguro (HTTP solo redirige, HSTS, versiones de TLS).
//   docker compose -f gateway/tests/compose.test.yml up -d --build --wait
//   NODE_EXTRA_CA_CERTS=gateway/tests/certs/ca.crt node --test gateway/tests/contract.test.mjs   (Node >= 22)
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import { test } from "node:test";
import tls from "node:tls";
import { fileURLToPath } from "node:url";

const GW = process.env.GATEWAY_URL || "https://localhost:18443";
const GW_HTTP = process.env.GATEWAY_HTTP_URL || "http://localhost:18088";
const NOTOKEN = process.env.GATEWAY_NOTOKEN_URL || "https://localhost:18444";
const LIMITED = process.env.GATEWAY_LIMITED_URL || "https://localhost:18445";
const DOWN = process.env.GATEWAY_DOWN_URL || "https://localhost:18446";

const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1MSJ9.firma-de-prueba";

// --- P3 · S2: access log del banco (us=- = el gateway no consultó a ningún upstream) y
// peticiones crudas (fetch normaliza la ruta y no deja enviar Host, CR/LF ni peticiones a medias).
const BENCH = fileURLToPath(new URL("./compose.test.yml", import.meta.url));
const CA = process.env.NODE_EXTRA_CA_CERTS ? fs.readFileSync(process.env.NODE_EXTRA_CA_CERTS) : undefined;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Valores de us= de las líneas del access log con ese X-Request-ID (espera hasta 3 s a que aparezcan). */
async function upstreamOf(rid, service = "gateway") {
  for (let i = 0; i < 15; i++) {
    const log = execFileSync("docker", ["compose", "-f", BENCH, "logs", "--no-color", "--no-log-prefix", service], { encoding: "utf8" });
    const found = log.split(/\r?\n/).filter((l) => l.includes(`rid=${rid} `)).map((l) => /us=(\S+)/.exec(l)?.[1]);
    if (found.length) return found;
    await sleep(200);
  }
  return [];
}

function rawSocket(base) {
  const { hostname, port, protocol } = new URL(base);
  return new Promise((resolve, reject) => {
    const s =
      protocol === "https:"
        ? tls.connect({ host: hostname, port: Number(port), servername: hostname, ca: CA, ALPNProtocols: ["http/1.1"] }, () => resolve(s))
        : net.connect({ host: hostname, port: Number(port) }, () => resolve(s));
    s.once("error", reject);
  });
}

/** Envía la petición tal cual y devuelve { status, headers, body } al cerrar el servidor. */
async function raw(base, text, { timeout = 8000 } = {}) {
  const s = await rawSocket(base);
  return new Promise((resolve) => {
    const chunks = [];
    const done = () => {
      clearTimeout(t);
      s.destroy();
      const buf = Buffer.concat(chunks).toString("latin1");
      const [head = "", ...rest] = buf.split("\r\n\r\n");
      const [line = "", ...hs] = head.split("\r\n");
      const headers = {};
      for (const h of hs) {
        const i = h.indexOf(":");
        const k = h.slice(0, i).trim().toLowerCase();
        headers[k] = headers[k] ? [].concat(headers[k], h.slice(i + 1).trim()) : h.slice(i + 1).trim();
      }
      resolve({ status: Number(/^HTTP\/1\.1 (\d{3})/.exec(line)?.[1]), headers, body: Buffer.from(rest.join("\r\n\r\n"), "latin1").toString("utf8") });
    };
    const t = setTimeout(done, timeout);
    s.on("data", (c) => chunks.push(c));
    s.on("end", done);
    s.on("close", done);
    s.on("error", done);
    s.write(text);
  });
}
const req = (base, line, headers = [], body = "") =>
  [line, `Host: ${new URL(base).host}`, "Connection: close", ...headers, "", body].join("\r\n");

/** Respuesta generada por el gateway: JSON con detail, sin la página HTML de Nginx. */
async function assertGatewayJson(res, status) {
  assert.equal(res.status, status);
  const ct = typeof res.headers?.get === "function" ? res.headers.get("content-type") : res.headers["content-type"];
  assert.match(ct ?? "", /application\/json/);
  const body = typeof res.text === "function" ? await res.text() : res.body;
  assert.ok(typeof JSON.parse(body).detail === "string", body);
  assert.doesNotMatch(body, /<html|nginx/i);
}

async function echo(base, path, init = {}) {
  const res = await fetch(base + path, { redirect: "manual", ...init });
  const body = await res.json();
  return { res, upstream: body };
}

/** Abre un WS y devuelve lo que el upstream vio en el handshake. */
function wsSeen(base, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(base.replace(/^http/, "ws") + path, { headers });
    const timer = setTimeout(() => reject(new Error("sin mensaje del upstream")), 5000);
    ws.onmessage = (e) => {
      clearTimeout(timer);
      ws.close();
      resolve(JSON.parse(String(e.data)));
    };
    ws.onerror = () => {};
    ws.onclose = (e) => {
      clearTimeout(timer);
      reject(new Error(`cierre ${e.code} sin mensaje`));
    };
  });
}

test("reescritura de rutas REST hacia cada servicio", async (t) => {
  const cases = [
    ["POST", "/api/auth/login", "/auth/login"],
    ["GET", "/api/auth/me", "/auth/me"],
    ["GET", "/api/boards", "/boards"],
    ["POST", "/api/boards", "/boards"],
    ["GET", "/api/boards/b1", "/boards/b1"],
    ["GET", "/api/boards/b1/members?x=1", "/boards/b1/members?x=1"],
    ["POST", "/api/boards/b1/invite", "/boards/b1/invite"],
    ["GET", "/api/invites/tok", "/invites/tok"],
    ["POST", "/api/invites/tok/accept", "/invites/tok/accept"],
    ["GET", "/api/canvas/boards/b1/state", "/boards/b1/state"],
    ["GET", "/api/canvas/boards/b1/versions", "/boards/b1/versions"],
    ["GET", "/api/canvas/boards/b1/versions/v-1", "/boards/b1/versions/v-1"],
    ["POST", "/api/canvas/boards/b1/versions/v-1/restore", "/boards/b1/versions/v-1/restore"],
    ["GET", "/api/chat/boards/b1/messages?limit=30&before=abc", "/api/chat/boards/b1/messages?limit=30&before=abc"],
    ["POST", "/api/chat/boards/b1/messages", "/api/chat/boards/b1/messages"],
    ["GET", "/api/pixels/board", "/api/pixels/board"],
    ["GET", "/api/notifications?limit=20", "/api/notifications?limit=20"],
    ["PATCH", "/api/notifications/n-1/read", "/api/notifications/n-1/read"],
  ];
  for (const [method, path, expected] of cases) {
    await t.test(`${method} ${path} -> ${expected}`, async () => {
      const { upstream } = await echo(GW, path, { method });
      assert.equal(upstream.url, expected);
      assert.equal(upstream.method, method);
    });
  }
});

test("Authorization, Cookie y Origin llegan al servicio sin modificar", async () => {
  const sent = { Authorization: `Bearer ${JWT}`, Cookie: `cb_session=${JWT}; otra=1`, Origin: "https://localhost:8443" };
  const { upstream } = await echo(GW, "/api/boards", { headers: sent });
  assert.equal(upstream.headers.authorization, sent.Authorization);
  assert.equal(upstream.headers.cookie, sent.Cookie);
  assert.equal(upstream.headers.origin, sent.Origin);
  assert.equal(upstream.headers["x-forwarded-host"], new URL(GW).host);
  assert.equal(upstream.headers["x-forwarded-proto"], "https");
  assert.match(upstream.headers["x-forwarded-for"], /\d+\.\d+\.\d+\.\d+/);
});

test("X-Request-ID: se genera, se respeta si es válido y se reemplaza si no", async () => {
  const generated = await echo(GW, "/api/boards");
  const rid = generated.res.headers.get("x-request-id");
  assert.match(rid, /^[A-Za-z0-9._-]{8,64}$/);
  assert.equal(generated.upstream.headers["x-request-id"], rid);

  const kept = await echo(GW, "/api/boards", { headers: { "X-Request-ID": "correlacion-123456" } });
  assert.equal(kept.res.headers.get("x-request-id"), "correlacion-123456");
  assert.equal(kept.upstream.headers["x-request-id"], "correlacion-123456");

  const replaced = await echo(GW, "/api/boards", { headers: { "X-Request-ID": "malo\twith space<>" } });
  assert.notEqual(replaced.res.headers.get("x-request-id"), "malo\twith space<>");
  assert.match(replaced.res.headers.get("x-request-id"), /^[A-Za-z0-9._-]{8,64}$/);
});

test("/internal/* nunca se publica", async (t) => {
  const paths = [
    "/internal/events",
    "/internal/boards/b1/access",
    "/api/internal/x",
    "/api/boards/internal/x",
    "/api/boards/b1/internal",
    "/api/chat/internal/events",
    "/api/notifications/internal/events",
    "/api/canvas/boards/internal/state",
    "/INTERNAL/x",
    "/ws/internal/x",
    "//internal/x",
    "/api/./internal/x",
    "/%69nternal/events",
  ];
  for (const path of paths) {
    await t.test(path, async () => {
      for (const method of ["GET", "POST"]) {
        const res = await fetch(GW + path, { method, redirect: "manual" });
        assert.equal(res.status, 404, `${method} ${path}`);
      }
    });
  }
});

test("rutas de canvas fuera del contrato no llegan a Pizarra", async () => {
  // P3 · S2 (ADR 0012, lista blanca de rutas): una ruta fuera del contrato ya no cae en la web
  // SSR (el `location /` del P2) sino en el 404 JSON del propio gateway, sin llegar a ningún
  // servicio. Aserción del P2, reemplazada:
  //   const { upstream } = await echo(GW, "/api/canvas/boards/b1/otra-cosa");
  //   assert.equal(upstream.url, "/api/canvas/boards/b1/otra-cosa");   // la recibía la web SSR
  const rid = `contrato-canvas-${Date.now()}`;
  const res = await fetch(GW + "/api/canvas/boards/b1/otra-cosa", { headers: { "X-Request-ID": rid } });
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { detail: "No encontrado" });
  assert.deepEqual(await upstreamOf(rid), ["-"], "no debe llegar a ningún upstream (us=-)");
});

test("la web SSR recibe las páginas; las APIs no", async () => {
  const { upstream } = await echo(GW, "/boards/b1?x=1");
  assert.equal(upstream.url, "/boards/b1?x=1");
});

test("WS Pizarra: el JWT de Authorization o de la cookie (web) se añade SOLO como ?token= hacia el servicio", async () => {
  const bearer = await wsSeen(GW, "/ws/boards/b1", { Authorization: `Bearer ${JWT}` });
  assert.equal(bearer.url, `/ws/boards/b1?token=${JWT}`);
  assert.equal(bearer.headers.authorization, `Bearer ${JWT}`);
  assert.equal(bearer.headers.upgrade?.toLowerCase(), "websocket");

  const cookie = await wsSeen(GW, "/ws/boards/b1", { Cookie: `cb_session=${JWT}`, Origin: "https://localhost:8443" });
  assert.equal(cookie.url, `/ws/boards/b1?token=${JWT}`);
  assert.equal(cookie.headers.cookie, `cb_session=${JWT}`);
  assert.equal(cookie.headers.origin, "https://localhost:8443");

  const anonymous = await wsSeen(GW, "/ws/boards/b1");
  assert.equal(anonymous.url, "/ws/boards/b1");
});

test("WS Pizarra: con PIZARRA_WS_TOKEN_QUERY=off no se añade ningún token a la URL", async () => {
  const seen = await wsSeen(NOTOKEN, "/ws/boards/b1", { Authorization: `Bearer ${JWT}` });
  assert.equal(seen.url, "/ws/boards/b1");
  assert.equal(seen.headers.authorization, `Bearer ${JWT}`);
});

test("WS Chat y Pixels: sin token en la URL; credenciales intactas", async () => {
  const chat = await wsSeen(GW, "/ws/chat/boards/b1?after=m1", { Authorization: `Bearer ${JWT}`, Cookie: `cb_session=${JWT}` });
  assert.equal(chat.url, "/ws/chat/boards/b1?after=m1");
  assert.equal(chat.headers.authorization, `Bearer ${JWT}`);
  assert.equal(chat.headers.cookie, `cb_session=${JWT}`);

  const pixels = await wsSeen(GW, "/ws/pixels");
  assert.equal(pixels.url, "/ws/pixels");
});

test("límite de tasa: /api/auth/ responde 429 con JSON y las demás rutas no se ven afectadas", async () => {
  const codes = [];
  for (let i = 0; i < 12; i++) codes.push((await fetch(LIMITED + "/api/auth/login", { method: "POST" })).status);
  assert.ok(codes.includes(429), `esperaba algún 429: ${codes}`);
  const limited = await fetch(LIMITED + "/api/auth/login", { method: "POST" });
  if (limited.status === 429) {
    assert.match((await limited.json()).detail, /Demasiadas/);
    assert.equal(limited.headers.get("retry-after"), "1");
  }
  assert.equal((await fetch(LIMITED + "/api/boards")).status, 200);
});

test("un servicio caído produce 502 JSON y el gateway sigue sirviendo el resto", async () => {
  const res = await fetch(DOWN + "/api/chat/boards/b1/messages");
  assert.equal(res.status, 502);
  assert.match((await res.json()).detail, /no disponible/i);
  assert.equal((await fetch(DOWN + "/api/boards")).status, 200);
  assert.equal((await fetch(DOWN + "/healthz")).status, 200);
});

test("/healthz del gateway no depende de los servicios", async () => {
  const res = await fetch(DOWN + "/healthz");
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "ok\n");
});

test("HTTP plano solo redirige a HTTPS (301) y no llega a ningún servicio", async (t) => {
  for (const [method, path] of [["GET", "/"], ["GET", "/login?next=/boards"], ["POST", "/api/auth/login"], ["GET", "/ws/chat/boards/b1"]]) {
    await t.test(`${method} ${path}`, async () => {
      const res = await fetch(GW_HTTP + path, { method, redirect: "manual" });
      assert.equal(res.status, 301);
      assert.equal(res.headers.get("location"), `${GW}${path}`);
      assert.equal(res.headers.get("x-powered-by"), null);
    });
  }
  // El healthcheck del contenedor sigue en HTTP.
  const health = await fetch(GW_HTTP + "/healthz");
  assert.equal(health.status, 200);
});

test("HTTPS envía HSTS en respuestas propias y de los servicios", async () => {
  for (const path of ["/healthz", "/api/boards", "/boards/b1"]) {
    const res = await fetch(GW + path);
    assert.match(res.headers.get("strict-transport-security") ?? "", /^max-age=\d+$/, path);
  }
});

/** Intenta un handshake TLS con un rango de versiones; devuelve la versión negociada o el error. */
function handshake(url, { minVersion, maxVersion }) {
  const { hostname, port } = new URL(url);
  return new Promise((resolve) => {
    // SECLEVEL=0 deja que el CLIENTE ofrezca TLS 1.0/1.1: así el rechazo lo decide el gateway.
    const socket = tls.connect({ host: hostname, port: Number(port), servername: hostname, minVersion, maxVersion, ciphers: "DEFAULT@SECLEVEL=0" }, () => {
      resolve({ ok: true, protocol: socket.getProtocol(), authorized: socket.authorized });
      socket.end();
    });
    socket.on("error", (err) => resolve({ ok: false, code: err.code }));
  });
}

test("TLS: 1.3 por defecto, 1.2 admitido, 1.0 y 1.1 rechazados por el gateway", async () => {
  const modern = await handshake(GW, { minVersion: "TLSv1.2", maxVersion: "TLSv1.3" });
  assert.deepEqual([modern.ok, modern.protocol, modern.authorized], [true, "TLSv1.3", true]);
  const v12 = await handshake(GW, { minVersion: "TLSv1.2", maxVersion: "TLSv1.2" });
  assert.equal(v12.protocol, "TLSv1.2");
  for (const version of ["TLSv1", "TLSv1.1"]) {
    const old = await handshake(GW, { minVersion: version, maxVersion: version });
    assert.equal(old.ok, false, `${version} no debe negociarse`);
    assert.match(old.code ?? "", /PROTOCOL_VERSION|UNSUPPORTED_PROTOCOL|NO_PROTOCOLS/, `${version}: ${old.code}`);
  }
});

// ============================================================================================
// P3 · S2 Reverse Proxy (ADR 0012): catálogo de security-tests/s2_catalogo.md contra el eco.
// Cada rechazo se comprueba además en el access log: us=- (no llegó a ningún upstream).
// ============================================================================================
const SECURITY = [
  "content-security-policy",
  "x-content-type-options",
  "x-frame-options",
  "referrer-policy",
  "permissions-policy",
  "cross-origin-opener-policy",
  "cross-origin-resource-policy",
  "strict-transport-security",
];
let ridSeq = 0;
const nextRid = (tag) => `s2-contrato-${tag}-${Date.now()}-${++ridSeq}`;
const withHost = (text, host) => text.replace(/^Host: .*$/m, `Host: ${host}`);

test("S2 lista blanca: lo no declarado -> 404 JSON del gateway, sin upstream", async (t) => {
  const paths = ["/s2-no-existe", "/api/s2-no-existe", "/api/auth/", "/api/boards/", "/bff/x", "/api/pixels/otra", "/api/chat/boards/b1/otra", "/_next/otra", "/__gw/400"];
  for (const path of paths) {
    await t.test(path, async () => {
      const rid = nextRid("404");
      const res = await fetch(GW + path, { headers: { "X-Request-ID": rid } });
      await assertGatewayJson(res, 404);
      assert.deepEqual(await upstreamOf(rid), ["-"]);
    });
  }
  // Rutas que fetch normalizaría: se envían crudas.
  for (const path of ["/%2569nternal/events", "/api/chat/%2569nternal/events", "/api/boards/%69nternal/x"]) {
    await t.test(`${path} (crudo)`, async () => {
      const rid = nextRid("404crudo");
      const res = await raw(GW, req(GW, `GET ${path} HTTP/1.1`, [`X-Request-ID: ${rid}`]));
      await assertGatewayJson(res, 404);
      assert.deepEqual(await upstreamOf(rid), ["-"]);
    });
  }
});

test("S2 lista blanca: las rutas reales de la web y de la UI de Pixels sí llegan a su servicio", async (t) => {
  const cases = [
    ["GET", "/", "/"],
    ["GET", "/login?next=/boards", "/login?next=/boards"],
    ["POST", "/login", "/login"],
    ["GET", "/register", "/register"],
    ["GET", "/boards/b1", "/boards/b1"],
    ["GET", "/join/tok_en-43", "/join/tok_en-43"],
    ["GET", "/session/expired", "/session/expired"],
    ["GET", "/bff/api/boards?x=1", "/bff/api/boards?x=1"],
    ["DELETE", "/bff/api/boards/b1", "/bff/api/boards/b1"],
    ["GET", "/_next/static/chunks/a-1.js", "/_next/static/chunks/a-1.js"],
    ["GET", "/favicon.svg", "/favicon.svg"],
    ["GET", "/collaboard-logo.svg", "/collaboard-logo.svg"],
    ["GET", "/pixels/", "/"],
    ["GET", "/pixels/assets/index-x.js", "/assets/index-x.js"],
  ];
  for (const [method, path, expected] of cases) {
    await t.test(`${method} ${path} -> ${expected}`, async () => {
      const { upstream } = await echo(GW, path, { method });
      assert.equal(upstream.url, expected);
    });
  }
  await t.test("/pixels -> 301 /pixels/ (relativo)", async () => {
    const res = await fetch(GW + "/pixels", { redirect: "manual" });
    assert.equal(res.status, 301);
    assert.equal(res.headers.get("location"), "/pixels/");
  });
});

test("S2 métodos: fuera de los permitidos -> 405 JSON con Allow, sin upstream; los permitidos llegan", async (t) => {
  const denied = [
    ["DELETE", "/login", "GET, HEAD, POST"],
    ["PUT", "/api/auth/login", "GET, HEAD, POST"],
    ["PUT", "/api/boards/b1", "GET, HEAD, POST, PATCH, DELETE"],
    ["POST", "/_next/static/chunks/a.js", "GET, HEAD"],
    ["PATCH", "/pixels/", "GET, HEAD"],
    ["POST", "/api/notifications", "GET, HEAD, PATCH, DELETE"],
  ];
  for (const [method, path, allow] of denied) {
    await t.test(`${method} ${path}`, async () => {
      const rid = nextRid("405");
      const res = await fetch(GW + path, { method, headers: { "X-Request-ID": rid } });
      assert.equal(res.headers.get("allow"), allow);
      await assertGatewayJson(res, 405);
      assert.deepEqual(await upstreamOf(rid), ["-"]);
    });
  }
  await t.test("TRACE / (crudo)", async () => {
    const res = await raw(GW, req(GW, "TRACE / HTTP/1.1"));
    await assertGatewayJson(res, 405);
  });
  for (const [method, path] of [
    ["PATCH", "/api/boards/b1"],
    ["DELETE", "/api/notifications/n-1"],
    ["PATCH", "/api/canvas/boards/b1/versions/v-1"],
  ]) {
    await t.test(`${method} ${path} llega`, async () => {
      const { upstream } = await echo(GW, path, { method });
      assert.equal(upstream.method, method);
    });
  }
});

test("S2 Host: fuera de GATEWAY_ALLOWED_HOSTS -> 421 JSON en :443 y :80, sin upstream", async (t) => {
  const cases = [
    [":443 Host falso", GW, (rid) => withHost(req(GW, "GET /api/boards HTTP/1.1", [`X-Request-ID: ${rid}`]), "evil-s2.example")],
    [":443 forma absoluta", GW, (rid) => req(GW, "GET http://evil-s2.example/api/boards HTTP/1.1", [`X-Request-ID: ${rid}`])],
    [":80 Host falso (no redirige a él)", GW_HTTP, (rid) => withHost(req(GW_HTTP, "GET /login HTTP/1.1", [`X-Request-ID: ${rid}`]), "evil-s2.example")],
  ];
  for (const [name, base, build] of cases) {
    await t.test(name, async () => {
      const rid = nextRid("421");
      const res = await raw(base, build(rid));
      await assertGatewayJson(res, 421);
      assert.equal(res.headers.location, undefined);
      assert.deepEqual(await upstreamOf(rid), ["-"]);
    });
  }
  await t.test("Host permitidos: localhost, 127.0.0.1 y gateway", async () => {
    for (const host of ["localhost:18443", "127.0.0.1:18443", "gateway"]) {
      const res = await raw(GW, withHost(req(GW, "GET /api/boards HTTP/1.1"), host));
      assert.equal(res.status, 200, host);
    }
  });
});

test("S2 saneado: el servicio no recibe IP, identidad ni rutas falsificadas por el cliente", async () => {
  const spoof = {
    "X-Forwarded-For": "203.0.113.66",
    "X-Real-IP": "203.0.113.77",
    "X-Service-Token": "token-falso",
    "X-User-Id": "usuario-falso",
    Forwarded: "for=203.0.113.88;host=evil-s2.example",
    "X-Forwarded-Host": "evil-s2.example",
    "X-Forwarded-Port": "1",
    "X-Original-URL": "/internal/events",
    "X-HTTP-Method-Override": "DELETE",
    "True-Client-IP": "203.0.113.99",
  };
  const { upstream } = await echo(GW, "/api/boards", { headers: spoof });
  const h = upstream.headers;
  assert.match(h["x-forwarded-for"], /^\d+\.\d+\.\d+\.\d+$/, "una sola IP: la que ve el gateway");
  assert.equal(h["x-real-ip"], h["x-forwarded-for"]);
  for (const v of Object.values(h)) assert.doesNotMatch(String(v), /203\.0\.113\.|evil-s2|falso|\/internal/);
  for (const k of ["x-service-token", "x-user-id", "forwarded", "x-forwarded-port", "x-original-url", "x-http-method-override", "true-client-ip"]) {
    assert.equal(h[k], undefined, k);
  }
  assert.equal(h["x-forwarded-host"], new URL(GW).host);

  const ws = await wsSeen(GW, "/ws/pixels", { "X-Forwarded-For": "203.0.113.66", "X-Service-Token": "token-falso" });
  assert.match(ws.headers["x-forwarded-for"], /^\d+\.\d+\.\d+\.\d+$/);
  assert.equal(ws.headers["x-service-token"], undefined);
});

test("S2 cabeceras de seguridad: una sola vez en respuestas del servicio y en los errores del gateway", async (t) => {
  const responses = {
    "200 del servicio": () => fetch(GW + "/api/boards"),
    "404 del gateway": () => fetch(GW + "/s2-no-existe"),
    "405 del gateway": () => fetch(GW + "/login", { method: "DELETE" }),
    "502 del gateway": () => fetch(DOWN + "/api/chat/boards/b1/messages"),
    "421 del gateway (crudo)": () => raw(GW, withHost(req(GW, "GET / HTTP/1.1"), "evil-s2.example")),
    "400 al leer la ruta (crudo)": () => raw(GW, req(GW, "GET /%2e%2e/internal HTTP/1.1")),
  };
  for (const [name, call] of Object.entries(responses)) {
    await t.test(name, async () => {
      const res = await call();
      const get = (hdr) => (typeof res.headers.get === "function" ? res.headers.get(hdr) : res.headers[hdr]);
      for (const hdr of SECURITY) {
        const v = get(hdr);
        // fetch une los duplicados con ", "; el lector crudo los devuelve como arreglo.
        assert.ok(v && !Array.isArray(v) && !/, (nosniff|DENY|same-origin|max-age)/.test(String(v)), `${hdr}: ${JSON.stringify(v)}`);
      }
      assert.match(get("content-security-policy"), /frame-ancestors 'none'/);
    });
  }
  await t.test("CSP de /pixels/: Google Fonts solo ahí, con la regla estricta en Report-Only", async () => {
    const pixels = await fetch(GW + "/pixels/");
    assert.match(pixels.headers.get("content-security-policy"), /style-src 'self' 'unsafe-inline' https:\/\/fonts\.googleapis\.com/);
    assert.equal(pixels.headers.get("content-security-policy-report-only"), "style-src 'self' 'unsafe-inline'; font-src 'self' data:");
    const login = await fetch(GW + "/login");
    assert.doesNotMatch(login.headers.get("content-security-policy"), /googleapis/);
    assert.equal(login.headers.get("content-security-policy-report-only"), null);
  });
});

test("S2 errores al leer la petición y tamaños: JSON del gateway, sin upstream", async (t) => {
  const cases = [
    ["/%2e%2e/ en la ruta", req(GW, "GET /%2e%2e/internal/events HTTP/1.1"), 400],
    ["CONNECT", req(GW, `CONNECT ${new URL(GW).host} HTTP/1.1`), 400],
    ["URI de 12 000 bytes", req(GW, `GET /login?q=${"A".repeat(12000)} HTTP/1.1`), 414],
    ["cabecera de 20 000 bytes", req(GW, "GET /login HTTP/1.1", [`X-Relleno: ${"A".repeat(20000)}`]), 431],
    ["línea plegada (obs-fold)", req(GW, "GET /api/boards HTTP/1.1", ["X-Request-ID: abcdefgh", " X-Inyectada: s2"]), 400],
  ];
  for (const [name, text, status] of cases) {
    await t.test(name, async () => assertGatewayJson(await raw(GW, text), status));
  }
  await t.test("HTTP plano contra el puerto TLS (497)", async () => {
    const { hostname, port } = new URL(GW);
    await assertGatewayJson(await raw(`http://${hostname}:${port}`, req(GW, "GET / HTTP/1.1")), 400);
  });
  const sizes = [
    ["cuerpo de 2 MiB en /api/boards (límite general 1m)", "/api/boards", 2 * 1024 * 1024, ""],
    ["cuerpo de 100 KiB en /api/auth/login (límite de la ruta 16k)", "/api/auth/login", 100 * 1024, "x".repeat(100 * 1024)],
  ];
  for (const [name, path, size, body] of sizes) {
    await t.test(name, async () => {
      const rid = nextRid("413");
      const res = await raw(GW, req(GW, `POST ${path} HTTP/1.1`, [`X-Request-ID: ${rid}`, "Content-Type: application/json", `Content-Length: ${size}`], body));
      await assertGatewayJson(res, 413);
      assert.deepEqual(await upstreamOf(rid), ["-"]);
    });
  }
});

test("S2 límites (variante limited): zona web, peticiones simultáneas por IP y WebSocket por IP", async (t) => {
  await t.test("zona web: ráfaga contra /login -> 429 JSON con Retry-After; las APIs no se ven afectadas", async () => {
    const codes = [];
    for (let i = 0; i < 8; i++) codes.push((await fetch(LIMITED + "/login")).status);
    assert.ok(codes.includes(429), `esperaba algún 429: ${codes}`);
    const limited = await fetch(LIMITED + "/login");
    if (limited.status === 429) {
      assert.equal(limited.headers.get("retry-after"), "1");
      await assertGatewayJson(limited, 429);
    }
    assert.equal((await fetch(LIMITED + "/api/boards")).status, 200);
  });
  await t.test("peticiones simultáneas (LIMIT_CONN_PER_IP=3): la 4.ª en curso -> 429 al instante", async () => {
    const pending = await Promise.all(Array.from({ length: 3 }, () => rawSocket(LIMITED)));
    for (const s of pending) s.write(req(LIMITED, "POST /api/boards HTTP/1.1", ["Content-Type: application/json", "Content-Length: 100"]));
    await sleep(300);
    const rid = nextRid("conn");
    const res = await raw(LIMITED, req(LIMITED, "GET /api/boards HTTP/1.1", [`X-Request-ID: ${rid}`]), { timeout: 3000 });
    pending.forEach((s) => s.destroy());
    await assertGatewayJson(res, 429);
    assert.deepEqual(await upstreamOf(rid, "gateway-limited"), ["-"]);
  });
  await t.test("WebSocket por IP (LIMIT_CONN_WS_PER_IP=1): el 2.º -> 429; las peticiones HTTP no cuentan", async () => {
    const upgrade = (rid) =>
      req(LIMITED, "GET /ws/pixels HTTP/1.1", [
        `X-Request-ID: ${rid}`,
        "Upgrade: websocket",
        "Sec-WebSocket-Version: 13",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
      ]).replace("Connection: close", "Connection: Upgrade");
    const first = await rawSocket(LIMITED);
    const opened = await new Promise((resolve) => {
      first.once("data", (c) => resolve(c.toString("latin1").startsWith("HTTP/1.1 101")));
      first.write(upgrade(nextRid("ws1")));
    });
    assert.ok(opened, "el primer WebSocket debe abrir");
    const rid = nextRid("ws2");
    const second = await raw(LIMITED, upgrade(rid), { timeout: 3000 });
    assert.equal((await fetch(LIMITED + "/api/boards")).status, 200);
    first.destroy();
    await assertGatewayJson(second, 429);
    assert.deepEqual(await upstreamOf(rid, "gateway-limited"), ["-"]);
  });
});

test("S2 tiempos: cabeceras lentas y cuerpo detenido se cortan a los 10 s (client_header/body_timeout)", async (t) => {
  // Devuelve los segundos hasta que el gateway cierra; tope de 20 s.
  const closedAfter = async (text, trickle) => {
    const s = await rawSocket(GW);
    const t0 = Date.now();
    return new Promise((resolve) => {
      const iv = trickle ? setInterval(() => s.write("X-Lento: a\r\n"), 2000) : null;
      const cap = setTimeout(() => done(), 20000);
      function done() {
        clearInterval(iv);
        clearTimeout(cap);
        s.destroy();
        resolve((Date.now() - t0) / 1000);
      }
      s.on("close", done);
      s.on("error", done);
      s.write(text);
    });
  };
  const [slowHeaders, stalledBody] = await Promise.all([
    closedAfter(`GET /login HTTP/1.1\r\nHost: ${new URL(GW).host}\r\n`, true),
    closedAfter(req(GW, "POST /api/boards HTTP/1.1", ["Content-Type: application/json", "Content-Length: 1000"], '{"name":"x'), false),
  ]);
  await t.test(`cabeceras lentas: cierre a los ${slowHeaders} s`, () => assert.ok(slowHeaders < 13));
  await t.test(`cuerpo detenido: cierre a los ${stalledBody} s`, () => assert.ok(stalledBody < 13));
});
