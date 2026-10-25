/**
 * Pruebas del contrato de Chat y Notificaciones contra los mocks.
 * Sirven también como especificación ejecutable para los servicios reales.
 *
 *     cd web-ssr/dev/mocks && npm test
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, describe, it } from "node:test";
import WebSocket from "ws";

const SECRET = "secreto-de-prueba-con-longitud-suficiente-32";
const SERVICE = "token-servicio-prueba";

// Colaboración falsa: ana y beto son miembros de b1; carla no.
const MEMBERS = { b1: ["ana", "beto"] };
let collab;
let mock;
let base;
let signJwt;

function userOf(req) {
  const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
  return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()).sub;
}

before(async () => {
  collab = createServer((req, res) => {
    const user = userOf(req);
    const [, , board, extra] = req.url.split("/");
    const members = MEMBERS[board] ?? [];
    if (!members.includes(user)) {
      res.writeHead(404).end(JSON.stringify({ detail: "Tablero no encontrado" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify(
        extra === "members"
          ? members.map((id) => ({ user_id: id, display_name: id, role: "editor" }))
          : { id: board, name: "Ideas del sprint", my_role: "editor" },
      ),
    );
  }).listen(0);
  await new Promise((resolve) => collab.once("listening", resolve));

  process.env.JWT_SECRET = SECRET;
  process.env.MOCK_SERVICE_TOKEN = SERVICE;
  process.env.COLLAB_URL = `http://127.0.0.1:${collab.address().port}`;
  const mocks = await import("./server.mjs");
  signJwt = mocks.signJwt;
  mock = mocks.start(0);
  await new Promise((resolve) => mock.once("listening", resolve));
  base = `http://127.0.0.1:${mock.address().port}`;
});

after(() => {
  mock.closeAllConnections?.();
  mock.close();
  collab.close();
});

const tokenFor = (sub, name = sub) => signJwt({ sub, name, exp: Math.floor(Date.now() / 1000) + 600 }, SECRET);

async function call(method, path, { user, body, headers = {} } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(user ? { Authorization: `Bearer ${tokenFor(user)}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/** Las notificaciones son asíncronas (como con la cola real): se espera a que aparezcan. */
async function eventually(check, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value || Date.now() > deadline) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const send = (user, text, clientId) =>
  call("POST", "/api/chat/boards/b1/messages", { user, body: { text, client_message_id: clientId } });

describe("chat", () => {
  it("exige un JWT válido", async () => {
    assert.equal((await call("GET", "/api/chat/boards/b1/messages")).status, 401);
    const forged = signJwt({ sub: "ana", exp: Math.floor(Date.now() / 1000) + 60 }, "otra-clave");
    const res = await call("GET", "/api/chat/boards/b1/messages", { headers: { Authorization: `Bearer ${forged}` } });
    assert.equal(res.status, 401);
  });

  it("rechaza a quien no es miembro del tablero", async () => {
    assert.equal((await call("GET", "/api/chat/boards/b1/messages", { user: "carla" })).status, 404);
    assert.equal((await send("carla", "hola", "carla-0000001")).status, 404);
  });

  it("un reenvío con el mismo client_message_id no duplica el mensaje", async () => {
    const first = await send("ana", "Hola equipo", "ana-msg-00001");
    const again = await send("ana", "Hola equipo", "ana-msg-00001");
    assert.equal(first.status, 201);
    assert.equal(again.status, 200);
    assert.equal(again.body.id, first.body.id);
    assert.equal(first.body.sender_id, "ana");
    const page = await call("GET", "/api/chat/boards/b1/messages", { user: "beto" });
    assert.equal(page.body.items.filter((m) => m.client_message_id === "ana-msg-00001").length, 1);
  });

  it("valida el texto", async () => {
    assert.equal((await send("ana", "   ", "ana-vacio-0001")).status, 422);
    assert.equal((await send("ana", "x".repeat(2001), "ana-largo-0001")).status, 422);
  });

  it("pagina hacia atrás con `before` y recupera lo nuevo con `after`", async () => {
    for (let i = 0; i < 5; i += 1) await send("beto", `m${i}`, `beto-page-000${i}`);
    const latest = await call("GET", "/api/chat/boards/b1/messages?limit=2", { user: "ana" });
    assert.deepEqual(latest.body.items.map((m) => m.text), ["m3", "m4"]);
    assert.ok(latest.body.next_cursor);
    const older = await call("GET", `/api/chat/boards/b1/messages?limit=2&before=${latest.body.next_cursor}`, { user: "ana" });
    assert.deepEqual(older.body.items.map((m) => m.text), ["m1", "m2"]);
    const newer = await call("GET", `/api/chat/boards/b1/messages?after=${older.body.items[1].id}`, { user: "ana" });
    assert.deepEqual(newer.body.items.map((m) => m.text), ["m3", "m4"]);
  });

  it("entrega los mensajes en vivo por WebSocket solo a miembros", async () => {
    const wsBase = base.replace("http", "ws");
    const outsider = new WebSocket(`${wsBase}/ws/chat/boards/b1`, { headers: { Cookie: `cb_session=${tokenFor("carla")}` } });
    const closeCode = await new Promise((resolve) => outsider.on("close", (code) => resolve(code)));
    assert.equal(closeCode, 4403);

    const member = new WebSocket(`${wsBase}/ws/chat/boards/b1`, { headers: { Cookie: `cb_session=${tokenFor("beto")}` } });
    await new Promise((resolve) => member.on("open", resolve));
    const received = new Promise((resolve) => member.on("message", (raw) => resolve(JSON.parse(String(raw)))));
    await send("ana", "¿Me ven?", "ana-live-00001");
    const event = await received;
    assert.equal(event.type, "message");
    assert.equal(event.message.text, "¿Me ven?");
    member.close();
  });
});

describe("notificaciones", () => {
  it("un mensaje notifica a los demás miembros, no al autor", async () => {
    await send("beto", "Revisen el diagrama", "beto-notif-0001");
    const isTarget = (n) => n.type === "chat.message.created" && n.payload.preview === "Revisen el diagrama";
    const ana = await eventually(async () => {
      const res = await call("GET", "/api/notifications", { user: "ana" });
      return res.body.items.some(isTarget) ? res : null;
    });
    assert.ok(ana, "ana debió recibir la notificación");
    const beto = await call("GET", "/api/notifications", { user: "beto" });
    assert.ok(!beto.body.items.some((n) => n.payload.preview === "Revisen el diagrama"));
    assert.ok(ana.body.unread_count >= 1);
  });

  it("nadie puede marcar ni ver notificaciones de otra cuenta", async () => {
    const ana = await call("GET", "/api/notifications", { user: "ana" });
    const target = ana.body.items[0];
    assert.equal((await call("PATCH", `/api/notifications/${target.id}/read`, { user: "beto" })).status, 404);
    const mine = await call("PATCH", `/api/notifications/${target.id}/read`, { user: "ana" });
    assert.equal(mine.status, 200);
    assert.ok(mine.body.read_at);
  });

  it("los eventos internos exigen identidad de servicio y son idempotentes", async () => {
    const event = {
      event_id: "evt-invite-1",
      type: "invite.accepted",
      occurred_at: new Date().toISOString(),
      actor_id: "beto",
      board_id: "b1",
      recipient_ids: ["ana"],
      payload: { board_name: "Ideas del sprint", actor_name: "Beto" },
    };
    assert.equal((await call("POST", "/internal/events", { body: event })).status, 401);
    const headers = { "X-Service-Token": SERVICE };
    const first = await call("POST", "/internal/events", { body: event, headers });
    const second = await call("POST", "/internal/events", { body: event, headers });
    assert.equal(first.status, 202);
    assert.equal(first.body.created, 1);
    assert.equal(second.body.created, 0);
    const ana = await call("GET", "/api/notifications", { user: "ana" });
    assert.equal(ana.body.items.filter((n) => n.type === "invite.accepted").length, 1);
  });

  it("rechaza eventos mal formados", async () => {
    const res = await call("POST", "/internal/events", {
      body: { event_id: "x", type: "otro", recipient_ids: [] },
      headers: { "X-Service-Token": SERVICE },
    });
    assert.equal(res.status, 422);
  });
});
