// STUB de NotificationAPI (C#): respuestas fijas para desarrollar la web, el
// cliente web y el gateway antes de que exista el servicio real (Cristian).
// No valida JWT, no persiste y no publica en RabbitMQ.
import http from "node:http";

const PORT = Number(process.env.PORT || 8080);
const PREFIX = process.env.API_PREFIX || "/api/notifications";
const SAMPLE = process.env.STUB_SAMPLE === "true";

const sample = {
  id: "00000000-0000-4000-8000-000000000001",
  type: "chat.message.created",
  board_id: "00000000-0000-4000-8000-0000000000b1",
  actor_id: "00000000-0000-4000-8000-0000000000a1",
  payload: { board_name: "Tablero de ejemplo (stub)", actor_name: "Stub", preview: "Notificación de prueba" },
  created_at: "2026-10-28T12:00:00Z",
  read_at: null,
};

function send(res, status, body) {
  const text = body === undefined ? "" : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "X-Collaboard-Stub": "notification-api",
  });
  res.end(text);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://stub");
  const path = url.pathname;
  const rid = req.headers["x-request-id"] ?? "-";
  console.log(`rid=${rid} ${req.method} ${path}`);
  req.resume();

  if (req.method === "GET" && path === "/health") return send(res, 200, { status: "ok", stub: true });

  if (req.method === "GET" && path === PREFIX) {
    return send(res, 200, SAMPLE ? { items: [sample], unread_count: 1 } : { items: [], unread_count: 0 });
  }
  const read = path.match(new RegExp(`^${PREFIX}/([A-Za-z0-9_-]+)/read$`));
  if (req.method === "PATCH" && read) {
    return send(res, 200, { ...sample, id: read[1], read_at: new Date().toISOString() });
  }
  if (req.method === "POST" && path === "/internal/events") return send(res, 202, { accepted: true, stub: true });
  return send(res, 404, { detail: "No encontrado (stub)" });
});

server.listen(PORT, "0.0.0.0", () => console.log(`notification-api STUB en :${PORT}`));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
