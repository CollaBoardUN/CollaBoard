// Upstream de prueba: responde con lo que recibió (método, URL, cabeceras) tanto por
// HTTP como en el handshake WebSocket (primer mensaje). Solo para las pruebas del gateway.
import { createHash } from "node:crypto";
import http from "node:http";

const PORT = Number(process.env.PORT || 4000);

const server = http.createServer((req, res) => {
  req.resume();
  const body = JSON.stringify({ method: req.method, url: req.url, headers: req.headers });
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(body);
});

// Handshake WebSocket mínimo (RFC 6455) sin dependencias.
server.on("upgrade", (req, socket) => {
  const accept = createHash("sha1")
    .update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
  socket.write(
    ["HTTP/1.1 101 Switching Protocols", "Upgrade: websocket", "Connection: Upgrade", `Sec-WebSocket-Accept: ${accept}`, "", ""].join("\r\n"),
  );
  const payload = Buffer.from(JSON.stringify({ url: req.url, headers: req.headers }));
  const header = payload.length < 126 ? Buffer.from([0x81, payload.length]) : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 0xff]);
  socket.write(Buffer.concat([header, payload]));
  // Cualquier trama del cliente (incluido su cierre) termina la conexión.
  socket.on("data", () => socket.end());
  socket.on("error", () => {});
});

server.listen(PORT, "0.0.0.0", () => console.log(`eco en :${PORT}`));
