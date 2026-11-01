// Contrato del gateway contra un upstream "eco": comprueba EXACTAMENTE qué recibe cada
// servicio (rutas reescritas, cabeceras sin tocar, token de Pizarra, X-Request-ID, bloqueos).
//   docker compose -f gateway/tests/compose.test.yml up -d --build --wait
//   node --test gateway/tests/contract.test.mjs        (Node >= 22)
import assert from "node:assert/strict";
import { test } from "node:test";

const GW = process.env.GATEWAY_URL || "http://localhost:18088";
const NOTOKEN = process.env.GATEWAY_NOTOKEN_URL || "http://localhost:18089";
const LIMITED = process.env.GATEWAY_LIMITED_URL || "http://localhost:18090";
const DOWN = process.env.GATEWAY_DOWN_URL || "http://localhost:18091";

const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1MSJ9.firma-de-prueba";

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
  const sent = { Authorization: `Bearer ${JWT}`, Cookie: `cb_session=${JWT}; otra=1`, Origin: "http://localhost:8088" };
  const { upstream } = await echo(GW, "/api/boards", { headers: sent });
  assert.equal(upstream.headers.authorization, sent.Authorization);
  assert.equal(upstream.headers.cookie, sent.Cookie);
  assert.equal(upstream.headers.origin, sent.Origin);
  assert.equal(upstream.headers["x-forwarded-host"], new URL(GW).host);
  assert.equal(upstream.headers["x-forwarded-proto"], "http");
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
  const { upstream } = await echo(GW, "/api/canvas/boards/b1/otra-cosa");
  // Cae en la web SSR (location /), jamás como /boards/... de Pizarra.
  assert.equal(upstream.url, "/api/canvas/boards/b1/otra-cosa");
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

  const cookie = await wsSeen(GW, "/ws/boards/b1", { Cookie: `cb_session=${JWT}`, Origin: "http://localhost:8088" });
  assert.equal(cookie.url, `/ws/boards/b1?token=${JWT}`);
  assert.equal(cookie.headers.cookie, `cb_session=${JWT}`);
  assert.equal(cookie.headers.origin, "http://localhost:8088");

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
