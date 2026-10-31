/**
 * Mocks de desarrollo de Chat API (Java) y NotificationAPI (C#) para la web SSR.
 *
 * Implementan el contrato de docs/p2/CONTRATOS_WEB.md para poder construir y
 * probar la interfaz antes de que existan los servicios reales. NO son parte del
 * despliegue final: el gateway los reemplaza por chat-api y notification-api.
 *
 * Se comportan como los servicios reales en lo que importa a la interfaz:
 *   - Validan el JWT (HS256, mismo JWT_SECRET) desde Bearer o cookie `cb_session`.
 *   - Consultan a Colaboración si la persona es miembro del tablero.
 *   - POST de chat idempotente por (board_id, sender_id, client_message_id).
 *   - Historial paginado por cursor (`before`) y recuperación (`after`).
 *   - Cada mensaje genera notificaciones para los demás miembros (chat.message.created).
 *   - `POST /internal/events` acepta eventos (p. ej. invite.accepted) de forma idempotente.
 *
 * Estado en memoria: se pierde al reiniciar (a propósito; es un mock).
 */
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT ?? 4100);
const JWT_SECRET = process.env.JWT_SECRET ?? "clave-de-desarrollo-cambiala-en-produccion-32b";
const COLLAB_URL = (process.env.COLLAB_URL ?? "http://localhost:8002").replace(/\/$/, "");
const SERVICE_TOKEN = process.env.MOCK_SERVICE_TOKEN ?? "token-de-servicio-solo-desarrollo";
const MAX_TEXT = 2000;
const PAGE_DEFAULT = 30;
const PAGE_MAX = 100;

// ---------------------------------------------------------------- utilidades

function log(msg, fields = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), svc: "dev-mocks", msg, ...fields }));
}

function b64url(input) {
  return Buffer.from(input).toString("base64url");
}

/** Verifica un JWT HS256 y devuelve sus claims, o null. */
export function verifyJwt(token, secret = JWT_SECRET, now = Date.now()) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    if (header.alg !== "HS256") return null;
    const expected = createHmac("sha256", secret).update(`${parts[0]}.${parts[1]}`).digest();
    const given = Buffer.from(parts[2], "base64url");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (typeof claims.sub !== "string" || !claims.sub) return null;
    if (typeof claims.exp !== "number" || claims.exp * 1000 <= now) return null;
    return claims;
  } catch {
    return null;
  }
}

/** Firma un JWT HS256 (solo para pruebas). */
export function signJwt(claims, secret = JWT_SECRET) {
  const head = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify(claims));
  const sig = createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

function cookieValue(header, name) {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

function tokenFrom(req) {
  const auth = req.headers.authorization ?? "";
  const [scheme, value] = auth.split(" ");
  if (scheme?.toLowerCase() === "bearer" && value) return value;
  return cookieValue(req.headers.cookie, "cb_session");
}

function send(res, status, body, requestId) {
  const headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
  if (requestId) headers["X-Request-Id"] = requestId;
  res.writeHead(status, headers);
  res.end(body === undefined ? "" : JSON.stringify(body));
}

async function readJson(req, limit = 64 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error("too_large"), { status: 413 });
    chunks.push(chunk);
  }
  if (chunks.length === 0) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("bad_json"), { status: 400 });
  }
}

// ---------------------------------------------------------------- autorización (Colaboración)

const accessCache = new Map(); // `${user}|${board}` -> { until, board }

/** ¿Es miembro? Pregunta a Colaboración con el mismo JWT del usuario (como hará Chat real). */
async function boardAccess(token, userId, boardId) {
  const key = `${userId}|${boardId}`;
  const hit = accessCache.get(key);
  if (hit && hit.until > Date.now()) return hit.board;
  let board = null;
  try {
    const res = await fetch(`${COLLAB_URL}/boards/${encodeURIComponent(boardId)}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(4000),
    });
    if (res.ok) board = await res.json();
    else if (res.status !== 404 && res.status !== 403) throw new Error(`colaboracion ${res.status}`);
  } catch (error) {
    log("collab_unavailable", { error: String(error) });
    throw Object.assign(new Error("Colaboración no responde"), { status: 503 });
  }
  accessCache.set(key, { until: Date.now() + 5000, board });
  return board;
}

async function boardMembers(token, boardId) {
  try {
    const res = await fetch(`${COLLAB_URL}/boards/${encodeURIComponent(boardId)}/members`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(4000),
    });
    return res.ok ? await res.json() : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------- chat

/** boardId -> mensajes en orden cronológico */
const messagesByBoard = new Map();
/** `${board}|${sender}|${clientId}` -> mensaje (idempotencia del POST) */
const byClientId = new Map();
/** boardId -> Set<ws> */
const chatSockets = new Map();

function boardMessages(boardId) {
  let list = messagesByBoard.get(boardId);
  if (!list) {
    list = [];
    messagesByBoard.set(boardId, list);
  }
  return list;
}

export function pageOf(list, { before, after, limit }) {
  const size = Math.min(Math.max(Number(limit) || PAGE_DEFAULT, 1), PAGE_MAX);
  if (after) {
    const index = list.findIndex((m) => m.id === after);
    const items = index === -1 ? list.slice(-size) : list.slice(index + 1, index + 1 + size);
    return { items, next_cursor: null };
  }
  let end = list.length;
  if (before) {
    const index = list.findIndex((m) => m.id === before);
    end = index === -1 ? 0 : index;
  }
  const start = Math.max(0, end - size);
  return { items: list.slice(start, end), next_cursor: start > 0 ? list[start].id : null };
}

function broadcastChat(boardId, message) {
  const payload = JSON.stringify({ type: "message", message });
  for (const socket of chatSockets.get(boardId) ?? []) {
    if (socket.readyState === socket.OPEN) socket.send(payload);
  }
}

// ---------------------------------------------------------------- notificaciones

/** userId -> notificaciones (más reciente primero) */
const inboxByUser = new Map();
/** `${event_id}|${recipient}` ya procesados (idempotencia del "worker") */
const processed = new Set();

export function deliverEvent(event) {
  let created = 0;
  for (const recipient of new Set(event.recipient_ids ?? [])) {
    if (!recipient || recipient === event.actor_id) continue; // nunca al autor
    const key = `${event.event_id}|${recipient}`;
    if (processed.has(key)) continue;
    processed.add(key);
    const list = inboxByUser.get(recipient) ?? [];
    list.unshift({
      id: randomUUID(),
      type: event.type,
      board_id: event.board_id ?? null,
      actor_id: event.actor_id ?? null,
      payload: event.payload ?? {},
      created_at: new Date().toISOString(),
      read_at: null,
    });
    inboxByUser.set(recipient, list.slice(0, 200));
    created += 1;
  }
  return created;
}

const EVENT_TYPES = new Set(["invite.accepted", "chat.message.created"]);

function validEvent(event) {
  return (
    event &&
    typeof event.event_id === "string" &&
    EVENT_TYPES.has(event.type) &&
    Array.isArray(event.recipient_ids) &&
    event.recipient_ids.every((id) => typeof id === "string")
  );
}

// ---------------------------------------------------------------- HTTP

async function handle(req, res) {
  const requestId = req.headers["x-request-id"] || randomUUID();
  const url = new URL(req.url, "http://mock");
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const started = Date.now();
  res.on("finish", () =>
    log("http", { request_id: requestId, method: req.method, path, status: res.statusCode, ms: Date.now() - started }),
  );

  if (path === "/health") return send(res, 200, { status: "ok", service: "dev-mocks" }, requestId);

  if (path === "/internal/events" && req.method === "POST") {
    if (req.headers["x-service-token"] !== SERVICE_TOKEN) return send(res, 401, { detail: "Servicio no autorizado" }, requestId);
    const event = await readJson(req);
    if (!validEvent(event)) return send(res, 422, { detail: "Evento inválido" }, requestId);
    const created = deliverEvent(event);
    return send(res, 202, { accepted: true, created }, requestId);
  }

  const token = tokenFrom(req);
  const claims = verifyJwt(token);
  if (!claims) return send(res, 401, { detail: "No autenticado" }, requestId);
  const userId = claims.sub;
  const userName = claims.name || claims.email || userId;

  // ---- bandeja
  if (path === "/api/notifications" && req.method === "GET") {
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 20, 1), 100);
    const list = inboxByUser.get(userId) ?? [];
    return send(res, 200, { items: list.slice(0, limit), unread_count: list.filter((n) => !n.read_at).length }, requestId);
  }
  const readMatch = path.match(/^\/api\/notifications\/([^/]+)\/read$/);
  if (readMatch && req.method === "PATCH") {
    const notification = (inboxByUser.get(userId) ?? []).find((n) => n.id === readMatch[1]);
    // Una notificación ajena responde igual que una inexistente.
    if (!notification) return send(res, 404, { detail: "Notificación no encontrada" }, requestId);
    notification.read_at ??= new Date().toISOString();
    return send(res, 200, notification, requestId);
  }

  // ---- chat
  const chatMatch = path.match(/^\/api\/chat\/boards\/([^/]+)\/messages$/);
  if (chatMatch) {
    const boardId = decodeURIComponent(chatMatch[1]);
    const board = await boardAccess(token, userId, boardId);
    if (!board) return send(res, 404, { detail: "Tablero no encontrado" }, requestId);
    const list = boardMessages(boardId);

    if (req.method === "GET") {
      return send(
        res,
        200,
        pageOf(list, {
          before: url.searchParams.get("before"),
          after: url.searchParams.get("after"),
          limit: url.searchParams.get("limit"),
        }),
        requestId,
      );
    }

    if (req.method === "POST") {
      const body = await readJson(req);
      const text = typeof body?.text === "string" ? body.text.trim() : "";
      const clientId = typeof body?.client_message_id === "string" ? body.client_message_id.trim() : "";
      if (!text) return send(res, 422, { detail: "El mensaje está vacío" }, requestId);
      if (text.length > MAX_TEXT) return send(res, 422, { detail: `Máximo ${MAX_TEXT} caracteres` }, requestId);
      if (!/^[A-Za-z0-9-]{8,64}$/.test(clientId)) return send(res, 422, { detail: "client_message_id inválido" }, requestId);

      const dedupeKey = `${boardId}|${userId}|${clientId}`;
      const existing = byClientId.get(dedupeKey);
      if (existing) return send(res, 200, existing, requestId);

      const message = {
        id: randomUUID(),
        board_id: boardId,
        sender_id: userId, // siempre del token, nunca del cuerpo
        sender_name: userName,
        text,
        client_message_id: clientId,
        created_at: new Date().toISOString(),
      };
      list.push(message);
      byClientId.set(dedupeKey, message);
      broadcastChat(boardId, message);
      send(res, 201, message, requestId);

      // Evento chat.message.created -> "NotificationAPI" (aquí en el mismo proceso).
      const members = await boardMembers(token, boardId);
      deliverEvent({
        event_id: message.id,
        type: "chat.message.created",
        occurred_at: message.created_at,
        actor_id: userId,
        board_id: boardId,
        recipient_ids: members.map((m) => m.user_id),
        payload: { board_name: board.name, actor_name: userName, preview: text.slice(0, 140) },
      });
      return undefined;
    }
    return send(res, 405, { detail: "Método no permitido" }, requestId);
  }

  return send(res, 404, { detail: "Ruta no encontrada" }, requestId);
}

const server = createServer((req, res) => {
  handle(req, res).catch((error) => {
    const status = error.status ?? 500;
    if (status === 500) log("error", { error: String(error?.stack ?? error) });
    if (!res.headersSent) send(res, status, { detail: status === 500 ? "Error interno del mock" : error.message });
  });
});

// ---------------------------------------------------------------- WebSocket del chat

const CLOSE_UNAUTHORIZED = 4401;
const CLOSE_FORBIDDEN = 4403;
const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, "http://mock");
  const match = url.pathname.match(/^\/ws\/chat\/boards\/([^/]+)$/);
  if (!match) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => void onChatSocket(ws, req, decodeURIComponent(match[1])));
});

async function onChatSocket(ws, req, boardId) {
  const token = tokenFrom(req);
  const claims = verifyJwt(token);
  if (!claims) return ws.close(CLOSE_UNAUTHORIZED, "No autenticado");
  let board;
  try {
    board = await boardAccess(token, claims.sub, boardId);
  } catch {
    return ws.close(1011, "Colaboración no responde");
  }
  if (!board) return ws.close(CLOSE_FORBIDDEN, "Sin acceso al tablero");

  const set = chatSockets.get(boardId) ?? new Set();
  set.add(ws);
  chatSockets.set(boardId, set);
  log("ws_open", { board_id: boardId, user_id: claims.sub, sockets: set.size });

  // Revalida el acceso periódicamente: quien sale del tablero deja de recibir mensajes.
  const recheck = setInterval(async () => {
    accessCache.delete(`${claims.sub}|${boardId}`);
    try {
      if (!(await boardAccess(token, claims.sub, boardId))) ws.close(CLOSE_FORBIDDEN, "Ya no eres miembro");
    } catch {
      // Colaboración caída: no se conceden permisos nuevos, pero se mantiene la conexión actual.
    }
  }, 15_000);

  ws.on("message", (raw) => {
    try {
      if (JSON.parse(String(raw)).type === "ping") ws.send(JSON.stringify({ type: "pong" }));
    } catch {
      ws.send(JSON.stringify({ type: "error", code: "bad_message", message: "JSON inválido" }));
    }
  });
  ws.on("close", () => {
    clearInterval(recheck);
    set.delete(ws);
  });
}

export function start(port = PORT) {
  return server.listen(port, () => log("listening", { port, collab_url: COLLAB_URL }));
}

export { server };
