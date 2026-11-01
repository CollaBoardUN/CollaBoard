// STUB del MessageWorker (C#): solo expone /health para que Compose lo marque
// sano. NO consume de RabbitMQ; el consumidor real lo implementa Cristian.
import http from "node:http";

const PORT = Number(process.env.PORT || 8080);

const server = http.createServer((req, res) => {
  req.resume();
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json", "X-Collaboard-Stub": "message-worker" });
    return res.end(JSON.stringify({ status: "ok", stub: true, consuming: false }));
  }
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ detail: "No encontrado (stub)" }));
});

server.listen(PORT, "0.0.0.0", () => console.log(`message-worker STUB en :${PORT} (no consume la cola)`));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
