#!/usr/bin/env node
// S2 · Reverse Proxy (P3): catálogo de ataques contra el borde del sistema, ejecutable.
//
//   P3 (después): node security-tests/s2_proxy.mjs --target https://localhost:8443 --ca gateway/certs/ca.crt
//   P2 (antes):   node security-tests/s2_proxy.mjs --target http://localhost:8088 \
//                   --pixels-ui http://localhost:3000/ --compose-dir ../p2-baseline
//
// Imprime OK/FAIL por caso y termina con código 1 si alguno falla. El resultado
// ESPERADO de cada caso es el del P3: contra el P2 falla lo que hoy es vulnerable.
// El catálogo (s2_catalogo.md) y la tabla P2 -> P3 se generan desde CATALOGO
// (ver s2_tabla.mjs): este archivo es la única fuente de los casos.
//
// Por qué sockets crudos (net/tls) y no fetch/curl: fetch normaliza la ruta
// (/a/../b -> /b, %2e -> .), rechaza CR/LF en cabeceras y no deja enviar una
// petición a medias. Aquí cada petición sale byte a byte como está escrita
// (HTTP/1.1; con HTTPS se negocia ALPN http/1.1).
//
// "No llegó al upstream" se comprueba con Docker (--compose-dir = carpeta del stack):
//  - Rechazos: cada caso envía un X-Request-ID único (s2-<caso>-<corrida>) y se busca
//    su línea en el access log del gateway: us=- significa que Nginx no consultó a
//    ningún servicio.
//  - Normalizaciones (cabeceras falsificadas): la petición legítima SÍ llega al
//    servicio; se captura el tramo interno gateway -> servicio (HTTP plano) con
//    tcpdump en el espacio de red del gateway y se comprueba que lo falsificado no está.
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { fileURLToPath } from "node:url";

const EVIL_HOST = "evil-s2.example";
const SPOOF = { xff: "203.0.113.66", realIp: "203.0.113.77", forwarded: "203.0.113.88" };
const SNIFF_IMAGE = "nicolaka/netshoot:v0.13";
// Cabeceras que delatan el stack de un servicio interno (además de Server con versión).
const STACK_HEADERS = ["x-powered-by", "x-aspnet-version", "x-aspnetmvc-version", "x-runtime", "x-generator", "via"];
const STACK_PREFIXES = ["x-nextjs-"];
// Cabeceras de seguridad que deben salir UNA vez en toda respuesta del borde.
const SECURITY_HEADERS = ["content-security-policy", "x-content-type-options", "referrer-policy", "permissions-policy", "x-frame-options"];
// Puertos de servicios, bases y broker que no deben estar abiertos en el host.
const PROBE_PORTS = [3000, 5432, 5672, 8000, 8001, 8002, 8080, 8081, 8090, 15432, 15433, 15434, 15435, 15672, 27017];
const SAFE_RID = /^[A-Za-z0-9._-]{8,64}$/;

/**
 * Catálogo: id, categoría, táctica de Bass (11.2), petición exacta, resultado esperado en el P3,
 * tipo (ataque | control) y cómo se verifica que no hubo upstream.
 *   verif: "log"      -> X-Request-ID del caso con us=- en el access log
 *          "captura"  -> tramo gateway -> servicio capturado sin la cabecera falsificada
 *          "tiempo"   -> el gateway corta la conexión antes del umbral
 *          "respuesta"-> se juzga solo la respuesta (cabeceras/estado)
 *          "puertos"  -> conexión TCP desde el host
 */
export const CATALOGO = [
  // --- Controles: tráfico legítimo que debe seguir funcionando (P2 y P3)
  { id: "K01", tipo: "control", cat: "Control", tactica: "—", peticion: "GET /healthz", esperado: "200", verif: "respuesta" },
  { id: "K02", tipo: "control", cat: "Control", tactica: "—", peticion: "GET /login", esperado: "200 text/html (web SSR)", verif: "respuesta" },
  { id: "K03", tipo: "control", cat: "Control", tactica: "—", peticion: "GET /api/boards (sin sesión)", esperado: "401 JSON del servicio (sí llega al upstream)", verif: "respuesta" },
  { id: "K04", tipo: "control", cat: "Control", tactica: "—", peticion: "GET /api/pixels/board", esperado: "200", verif: "respuesta" },
  { id: "K05", tipo: "control", cat: "Control", tactica: "—", peticion: "GET <UI de Pixels> (P2 :3000/ · P3 /pixels/)", esperado: "200 text/html", verif: "respuesta" },

  // --- A. Rutas internas y canonicalización de la ruta
  { id: "A01", cat: "Rutas internas", tactica: "Limit access", peticion: "GET /internal/events", esperado: "404 JSON del gateway, sin upstream", verif: "log" },
  { id: "A02", cat: "Rutas internas", tactica: "Limit access", peticion: "POST /internal/boards/b1/access", esperado: "404 JSON del gateway, sin upstream", verif: "log" },
  { id: "A03", cat: "Rutas internas", tactica: "Limit access", peticion: "GET //internal/events", esperado: "404 JSON del gateway, sin upstream", verif: "log" },
  { id: "A04", cat: "Rutas internas", tactica: "Limit access", peticion: "GET /INTERNAL/events", esperado: "404 JSON del gateway, sin upstream", verif: "log" },
  // aislar + logHint: Nginx rechaza estas peticiones antes de leer X-Request-ID, así que su línea
  // se identifica por segundo propio, estado y "método uri" tal como los registra el log: en el P2
  // con la página HTML de Nginx ("GET " o "- -"); en el P3, tras la redirección interna a la
  // página de error JSON ("GET /__gw/400", "GET /__gw/414").
  { id: "A05", cat: "Rutas internas", tactica: "Limit access", peticion: "GET /%2e%2e/internal/events (sin normalizar)", esperado: "400 o 404 JSON del gateway, sin upstream", verif: "log", aislar: true, logHint: [["GET", ""], ["GET", "/__gw/400"]] },
  { id: "A06", cat: "Rutas internas", tactica: "Limit access", peticion: "GET /api/boards/../internal/events (sin normalizar)", esperado: "404 JSON del gateway, sin upstream", verif: "log" },
  { id: "A07", cat: "Rutas internas", tactica: "Limit access", peticion: "GET /api/boards/%2e%2e/%2e%2e/internal/boards/b1/access", esperado: "404 JSON del gateway, sin upstream", verif: "log" },
  { id: "A08", cat: "Rutas internas", tactica: "Limit access", peticion: "GET /%69nternal/events (i codificada)", esperado: "404 JSON del gateway, sin upstream", verif: "log" },
  { id: "A09", cat: "Rutas internas", tactica: "Limit access", peticion: "GET /%2569nternal/events (doble codificación)", esperado: "404 JSON del gateway, sin upstream", verif: "log" },
  { id: "A10", cat: "Rutas internas", tactica: "Limit access", peticion: "GET /internal%2fevents (barra codificada)", esperado: "404 JSON del gateway, sin upstream", verif: "log" },
  { id: "A11", cat: "Rutas internas", tactica: "Limit access", peticion: "GET /api/chat/%2569nternal/events (doble codificación bajo un prefijo que se reenvía sin reescribir)", esperado: "404 JSON del gateway, sin upstream", verif: "log" },

  // --- B. Métodos
  { id: "B01", cat: "Métodos", tactica: "Limit access", peticion: "TRACE / HTTP/1.1", esperado: "405 JSON del gateway, sin upstream", verif: "log" },
  { id: "B02", cat: "Métodos", tactica: "Limit access", peticion: "CONNECT <host>:<puerto> HTTP/1.1", esperado: "400 o 405 JSON del gateway, sin upstream", verif: "log", aislar: true, logHint: [["-", "-"], ["GET", "/__gw/400"]] },
  { id: "B03", cat: "Métodos", tactica: "Limit access", peticion: "DELETE /login", esperado: "405 JSON del gateway, sin upstream", verif: "log" },
  { id: "B04", cat: "Métodos", tactica: "Limit access", peticion: "PUT /api/auth/login", esperado: "405 JSON del gateway, sin upstream", verif: "log" },

  // --- C. Host y cabeceras del cliente
  { id: "C01", cat: "Host y cabeceras", tactica: "Validate input", peticion: `GET / con Host: ${EVIL_HOST}`, esperado: "421 JSON del gateway, sin upstream", verif: "log" },
  { id: "C02", cat: "Host y cabeceras", tactica: "Validate input", peticion: `GET http://${EVIL_HOST}/ HTTP/1.1 (forma absoluta) con Host legítimo`, esperado: "421 JSON del gateway, sin upstream", verif: "log" },
  { id: "C03", cat: "Host y cabeceras", tactica: "Validate input", peticion: `GET /api/boards con X-Forwarded-For: ${SPOOF.xff}`, esperado: "el servicio recibe X-Forwarded-For = IP real del cliente, sin el valor falsificado", verif: "captura" },
  { id: "C04", cat: "Host y cabeceras", tactica: "Validate input", peticion: `GET /api/boards con X-Real-IP: ${SPOOF.realIp}`, esperado: "el servicio no recibe el X-Real-IP falsificado", verif: "captura" },
  { id: "C05", cat: "Host y cabeceras", tactica: "Validate input", peticion: "GET /api/boards con X-Service-Token: s2-token-falso-<corrida>", esperado: "el servicio no recibe X-Service-Token", verif: "captura" },
  { id: "C06", cat: "Host y cabeceras", tactica: "Validate input", peticion: "GET /api/boards con X-User-Id: s2-usuario-falso-<corrida>", esperado: "el servicio no recibe X-User-Id", verif: "captura" },
  { id: "C07", cat: "Host y cabeceras", tactica: "Validate input", peticion: `GET /api/boards con X-Forwarded-Host: ${EVIL_HOST} y Forwarded: for=${SPOOF.forwarded};host=${EVIL_HOST};proto=http`, esperado: `el servicio no recibe ${EVIL_HOST} ni ${SPOOF.forwarded}`, verif: "captura" },
  { id: "C08", cat: "Host y cabeceras", tactica: "Validate input", peticion: 'GET /api/boards con X-Request-ID: abc def" us=200 up=10.0.0.1 (falsificar campos del log)', esperado: "X-Request-ID reemplazado por uno generado (formato estricto)", verif: "respuesta" },
  { id: "C09", cat: "Host y cabeceras", tactica: "Validate input", peticion: "GET /api/boards con X-Request-ID seguido de una línea plegada (obs-fold: CRLF + espacio + X-Inyectada: s2)", esperado: "400 JSON, o X-Request-ID válido sin rastro de la línea inyectada", verif: "respuesta" },
  { id: "C10", cat: "Host y cabeceras", tactica: "Validate input", peticion: "GET /api/boards con X-Request-ID que contiene un CR suelto (\\r) + X-Inyectada: s2", esperado: "400 JSON, o X-Request-ID válido sin rastro de la línea inyectada", verif: "respuesta" },

  // --- D. Tamaños
  { id: "D01", cat: "Tamaños", tactica: "Detect service denial", peticion: "POST /api/boards con Content-Length: 2097152 (2 MiB > CLIENT_MAX_BODY_SIZE=1m)", esperado: "413 JSON del gateway, sin upstream", verif: "log" },
  { id: "D02", cat: "Tamaños", tactica: "Detect service denial", peticion: "GET /login con una cabecera de 20 000 bytes", esperado: "400/431 JSON del gateway, sin upstream", verif: "log" },
  { id: "D03", cat: "Tamaños", tactica: "Detect service denial", peticion: "GET /login?q=<12 000 bytes>", esperado: "414 JSON del gateway, sin upstream", verif: "log", aislar: true, logHint: [["-", "-"], ["GET", "/__gw/414"]] },
  { id: "D04", cat: "Tamaños", tactica: "Detect service denial", peticion: "POST /api/auth/login con cuerpo JSON de 100 KiB (límite propio de la ruta)", esperado: "413 JSON del gateway, sin upstream", verif: "log" },

  // --- E. Lentitud y volumen
  { id: "E01", cat: "Lentitud y volumen", tactica: "Detect service denial", peticion: "GET /login enviando una cabecera cada 2 s sin terminar nunca (slow headers)", esperado: "el gateway cierra la conexión en <= 15 s", verif: "tiempo" },
  { id: "E02", cat: "Lentitud y volumen", tactica: "Detect service denial", peticion: "POST /api/boards con Content-Length: 1000, 10 bytes de cuerpo y luego nada (slow body)", esperado: "el gateway cierra en <= 15 s, sin upstream", verif: "log" },
  { id: "E03", cat: "Lentitud y volumen", tactica: "Detect service denial", peticion: "120 conexiones desde una IP (una cada 50 ms, bajo la tasa de limit_req), cada una POST /api/boards con el cuerpo pendiente", esperado: "las que superan el límite de conexiones por IP reciben 429 JSON al instante, sin upstream (error log: «limiting connections», sin «limiting requests»)", verif: "log" },
  { id: "E04", cat: "Lentitud y volumen", tactica: "Detect service denial", peticion: "300 GET /login en ráfaga (30 en paralelo)", esperado: "429 JSON con las cabeceras de seguridad, sin upstream", verif: "log" },
  { id: "E05", cat: "Lentitud y volumen", tactica: "Detect service denial", peticion: "GET del estático más grande de la web sin leer la respuesta (SO_RCVBUF=1 KiB, 25 s), desde un contenedor en la red edge (slow read)", esperado: "el gateway corta el envío (send_timeout): cuerpo truncado y conexión cerrada por el gateway", verif: "tiempo" },
  { id: "E06", cat: "Lentitud y volumen", tactica: "Detect service denial", peticion: "40 WebSocket a /ws/pixels abiertos a la vez desde una IP (uno cada 50 ms)", esperado: "los que superan el límite de WebSocket por IP reciben 429 JSON, sin upstream (error log: zona conn_ws)", verif: "log" },

  // --- F. Exposición
  { id: "F01", cat: "Exposición", tactica: "Limit exposure", peticion: "GET /s2-no-existe", esperado: "404 JSON del gateway, sin upstream", verif: "log" },
  { id: "F02", cat: "Exposición", tactica: "Limit exposure", peticion: "GET /api/s2-no-existe", esperado: "404 JSON del gateway, sin upstream", verif: "log" },
  { id: "F03", cat: "Exposición", tactica: "Limit exposure", peticion: "GET /api/canvas/boards/b1/otra-cosa", esperado: "404 JSON del gateway, sin upstream", verif: "log" },
  { id: "F04", cat: "Exposición", tactica: "Limit exposure", peticion: "GET a 8 rutas (web, 5 APIs, 404 y UI de Pixels): cabeceras de respuesta", esperado: "Server ausente o «nginx» sin versión; 0 cabeceras de los servicios (X-Powered-By, x-nextjs-*, …)", verif: "respuesta" },
  { id: "F05", cat: "Exposición", tactica: "Limit exposure", peticion: "GET /login, /api/boards, /s2-no-existe y UI de Pixels: cabeceras de seguridad", esperado: "CSP (con frame-ancestors), nosniff, Referrer-Policy, Permissions-Policy y X-Frame-Options exactamente una vez; HSTS una vez con HTTPS", verif: "respuesta" },
  { id: "F06", cat: "Exposición", tactica: "Limit access", peticion: `Puertos publicados por el stack (docker compose ps) y TCP desde el host a ${PROBE_PORTS.join(", ")} en 127.0.0.1 y en las IP de la LAN`, esperado: "el stack solo publica los puertos del gateway y 127.0.0.1:15672; ningún otro puerto del stack responde", verif: "puertos" },
];

// ---------------------------------------------------------------- utilidades
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function endpoint(raw) {
  const url = new URL(raw);
  const https = url.protocol === "https:";
  return { url, https, hostname: url.hostname.replace(/^\[|\]$/g, ""), port: Number(url.port || (https ? 443 : 80)), host: url.host, path: url.pathname || "/" };
}

function hget(headers, name) {
  const h = headers.find(([k]) => k === name);
  return h ? h[1] : undefined;
}
const hall = (headers, name) => headers.filter(([k]) => k === name).map(([, v]) => v);

function dechunk(buf) {
  const out = [];
  let i = 0;
  while (i < buf.length) {
    const nl = buf.indexOf("\r\n", i);
    if (nl < 0) break;
    const size = parseInt(buf.subarray(i, nl).toString("latin1").split(";")[0], 16);
    if (!size) break;
    out.push(buf.subarray(nl + 2, nl + 2 + size));
    i = nl + 2 + size + 2;
  }
  return Buffer.concat(out);
}

function parseResponse(buf) {
  if (!buf.length) return { status: null, headers: [], body: "" };
  const sep = buf.indexOf("\r\n\r\n");
  const head = buf.subarray(0, sep < 0 ? buf.length : sep).toString("latin1");
  const lines = head.split("\r\n");
  const m = /^HTTP\/\d(?:\.\d)? (\d{3})/.exec(lines[0]);
  const headers = lines.slice(1).filter(Boolean).map((l) => {
    const i = l.indexOf(":");
    return [l.slice(0, i).trim().toLowerCase(), l.slice(i + 1).trim()];
  });
  let body = sep < 0 ? Buffer.alloc(0) : buf.subarray(sep + 4);
  if ((hget(headers, "transfer-encoding") || "").toLowerCase().includes("chunked")) body = dechunk(body);
  return { status: m ? Number(m[1]) : null, headers, body: body.toString("utf8") };
}

let CA;
function openSocket(ep) {
  return new Promise((resolve, reject) => {
    const opts = { host: ep.hostname, port: ep.port };
    const s = ep.https
      ? tls.connect({ ...opts, servername: net.isIP(ep.hostname) ? undefined : ep.hostname, ca: CA, ALPNProtocols: ["http/1.1"] }, () => resolve(s))
      : net.connect(opts, () => resolve(s));
    s.once("error", reject);
  });
}

/** Envía bytes tal cual y recoge la respuesta hasta que el servidor cierre (Connection: close). */
async function exchange(ep, payload, { timeout = 10000 } = {}) {
  const t0 = Date.now();
  let sock;
  try {
    sock = await openSocket(ep);
  } catch (e) {
    return { status: null, headers: [], body: "", error: e.code || e.message, elapsed: Date.now() - t0, t0, t1: Date.now() };
  }
  return new Promise((resolve) => {
    const chunks = [];
    let done = false;
    const finish = (why) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      resolve({ ...parseResponse(Buffer.concat(chunks)), why, elapsed: Date.now() - t0, t0, t1: Date.now() });
    };
    const timer = setTimeout(() => finish("timeout"), timeout);
    sock.on("data", (c) => chunks.push(c));
    sock.on("end", () => finish("end"));
    sock.on("close", () => finish("close"));
    sock.on("error", (e) => finish(`error:${e.code || e.message}`));
    sock.write(payload);
  });
}

/** Construye una petición HTTP/1.1 sin ninguna normalización. */
function build(ep, { method = "GET", path: p = "/", requestLine, host, rid, headers = [], raw = "", body } = {}) {
  const lines = [requestLine ?? `${method} ${p} HTTP/1.1`];
  if (host !== null) lines.push(`Host: ${host ?? ep.host}`);
  lines.push("User-Agent: s2-proxy/1.0", "Accept: */*", "Connection: close");
  if (rid) lines.push(`X-Request-ID: ${rid}`);
  for (const [k, v] of headers) lines.push(`${k}: ${v}`);
  if (body != null && !headers.some(([k]) => k.toLowerCase() === "content-length")) lines.push(`Content-Length: ${Buffer.byteLength(body)}`);
  let head = lines.join("\r\n") + "\r\n";
  if (raw) head += raw + "\r\n";
  return Buffer.concat([Buffer.from(head + "\r\n", "latin1"), body != null ? Buffer.from(body) : Buffer.alloc(0)]);
}

function snippet(text, n = 70) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n) + "…" : s;
}
function describe(res) {
  if (res.status == null) return `sin respuesta (${res.error || res.why}, ${(res.elapsed / 1000).toFixed(1)} s)`;
  const ct = (hget(res.headers, "content-type") || "-").split(";")[0];
  return `${res.status} ${ct} ${snippet(res.body)}`;
}
/** Respuesta generada por el gateway: JSON válido y sin HTML ni firma de Nginx. */
function isGatewayJson(res) {
  const ct = hget(res.headers, "content-type") || "";
  let parsed = false;
  try {
    JSON.parse(res.body);
    parsed = true;
  } catch {
    /* no es JSON */
  }
  return ct.includes("application/json") && parsed && !/<html|<center>|nginx/i.test(res.body);
}
const rejected = (res, codes) => ({ ok: codes.includes(res.status) && isGatewayJson(res), detail: describe(res) });

async function pool(items, size, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

function probe(host, port, ms = 1200) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (open) => {
      s.destroy();
      resolve(open);
    };
    s.setTimeout(ms, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}

// ---------------------------------------------------------------- Docker (log y captura)
function compose(dir, args, opts = {}) {
  return execFileSync("docker", ["compose", ...args], { cwd: dir, encoding: "utf8", maxBuffer: 256 << 20, ...opts });
}

const LOG_RE = /^(\S+) \[([^\]]+)\] "(\S*) ?([^"]*)" (\d{3}) rid=(\S+) up=(.*?) us=(.*?) rt=(\S+)$/;
// Error log de Nginx (stderr del contenedor): "2026/11/19 21:46:50 [error] 32#32: *123 limiting connections by zone ..."
const ERR_RE = /^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}:\d{2}:\d{2}) \[(\w+)\] .*?(limiting (?:requests|connections))(?:.*?by zone "(\w+)")?/;
function readGatewayLog(dir, sinceMs) {
  const text = compose(dir, ["logs", "--no-color", "--no-log-prefix", "--since", new Date(sinceMs - 5000).toISOString(), "gateway"]);
  const rows = text.split(/\r?\n/).map((l) => l.trim());
  const access = rows
    .map((line) => {
      const m = LOG_RE.exec(line);
      return m && { line, ip: m[1], time: Date.parse(m[2]), method: m[3], uri: m[4], status: Number(m[5]), rid: m[6], up: m[7], us: m[8] };
    })
    .filter(Boolean);
  // El contenedor usa UTC (igual que $time_iso8601 del access log).
  const errors = rows
    .map((line) => {
      const m = ERR_RE.exec(line);
      return m && { line, time: Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}Z`), kind: m[6], zone: m[7] || null };
    })
    .filter(Boolean);
  return { access, errors };
}

async function startCapture(dir, tag) {
  const id = compose(dir, ["ps", "-q", "gateway"]).trim();
  if (!id) throw new Error(`no hay contenedor gateway en ${dir}`);
  execFileSync("docker", ["pull", "-q", SNIFF_IMAGE], { stdio: "ignore", timeout: 600000 });
  const name = `s2-captura-${tag}`;
  // Tramo gateway -> servicios en :8000 (collaboration-api, pizarra-api, pixels-api): HTTP plano.
  const proc = spawn("docker", ["run", "--rm", "--name", name, "--network", `container:${id}`, SNIFF_IMAGE, "tcpdump", "-i", "any", "-A", "-s", "0", "-l", "-n", "tcp dst port 8000"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  proc.stdout.on("data", (c) => (out += c.toString("latin1")));
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("tcpdump no arrancó en 60 s")), 60000);
    proc.stderr.on("data", (c) => {
      if (/listening on/i.test(c.toString())) {
        clearTimeout(t);
        resolve();
      }
    });
    proc.on("exit", (code) => {
      clearTimeout(t);
      reject(new Error(`tcpdump terminó con código ${code}`));
    });
  });
  return {
    async stop() {
      await sleep(1500);
      try {
        execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" });
      } catch {
        /* ya terminó */
      }
      if (proc.exitCode === null) await new Promise((r) => proc.on("exit", r));
      return out;
    },
  };
}
/** Paquete capturado (texto de tcpdump -A) que contiene el X-Request-ID dado. */
function packetWith(capture, rid) {
  return capture.split(/\n(?=\d{2}:\d{2}:\d{2}\.\d+ )/).find((p) => p.includes(`X-Request-ID: ${rid}`));
}

// ---------------------------------------------------------------- casos
function makeRunners(ctx) {
  const { T, PX, rid, o } = ctx;
  const send = (id, spec, opts) => exchange(T, build(T, { rid: rid(id), ...spec }), opts);
  const reject = (codes, spec) => async (id) => ({ ...rejected(await send(id, spec), codes), rids: [rid(id)] });

  const sniffSpec = {
    C03: { headers: [["X-Forwarded-For", SPOOF.xff]], markers: [SPOOF.xff] },
    C04: { headers: [["X-Real-IP", SPOOF.realIp]], markers: [SPOOF.realIp] },
    C05: { headers: [["X-Service-Token", `s2-token-falso-${ctx.tag}`]], markers: [`s2-token-falso-${ctx.tag}`] },
    C06: { headers: [["X-User-Id", `s2-usuario-falso-${ctx.tag}`]], markers: [`s2-usuario-falso-${ctx.tag}`] },
    C07: {
      headers: [
        ["X-Forwarded-Host", EVIL_HOST],
        ["Forwarded", `for=${SPOOF.forwarded};host=${EVIL_HOST};proto=http`],
      ],
      markers: [EVIL_HOST, SPOOF.forwarded],
    },
  };
  // Fase 1 (con tcpdump activo): solo envía. Fase 2 (captura cerrada): evalúa.
  ctx.sniffFire = async (id) => {
    ctx.sniffRes[id] = await send(id, { path: "/api/boards", headers: sniffSpec[id].headers });
  };
  const sniffed = async (id) => {
    const res = ctx.sniffRes[id] ?? (await send(id, { path: "/api/boards", headers: sniffSpec[id].headers }));
    if (ctx.capture == null) return { ok: false, detail: `${describe(res)} · sin captura (requiere Docker)` };
    const packet = packetWith(ctx.capture, rid(id));
    if (!packet) return { ok: false, detail: `${describe(res)} · la petición no aparece en el tramo interno` };
    ctx.packets[id] = packet;
    const leaked = sniffSpec[id].markers.filter((m) => packet.includes(m));
    const seen = packet
      .split("\n")
      .filter((l) => /^(X-Forwarded-For|X-Real-IP|X-Service-Token|X-User-Id|X-Forwarded-Host|Forwarded):/i.test(l.trim()))
      .map((l) => l.trim().replace(/\.$/, ""));
    return {
      ok: leaked.length === 0,
      detail: `${res.status} · el servicio recibió: ${seen.join(" | ") || "(ninguna de estas cabeceras)"}${leaked.length ? ` · FALSIFICADO: ${leaked.join(", ")}` : ""}`,
    };
  };

  const injectedRid = (id, raw) => async () => {
    const res = await exchange(T, build(T, { path: "/api/boards", raw }));
    const echoed = hget(res.headers, "x-request-id") || "";
    const reflected = res.headers.some(([k, v]) => k === "x-inyectada" || /inyectada/i.test(v));
    // rids: el rid del caso se excluye de la búsqueda por ventana de los demás casos.
    if (res.status === 400) return { ok: isGatewayJson(res), detail: describe(res), rids: [rid(id)] };
    const ok = res.status != null && res.status < 500 && SAFE_RID.test(echoed) && !reflected;
    return { ok, detail: `${describe(res)} · X-Request-ID devuelto: ${JSON.stringify(echoed)}${reflected ? " · cabecera inyectada reflejada" : ""}`, rids: [rid(id)] };
  };

  return {
    K01: async () => {
      const r = await exchange(T, build(T, { path: "/healthz" }));
      return { ok: r.status === 200, detail: describe(r) };
    },
    K02: async () => {
      const r = await exchange(T, build(T, { path: "/login" }));
      return { ok: r.status === 200 && (hget(r.headers, "content-type") || "").includes("text/html"), detail: describe(r) };
    },
    K03: async () => {
      const r = await exchange(T, build(T, { path: "/api/boards" }));
      return { ok: r.status === 401 && (hget(r.headers, "content-type") || "").includes("json"), detail: describe(r) };
    },
    K04: async () => {
      const r = await exchange(T, build(T, { path: "/api/pixels/board" }));
      return { ok: r.status === 200, detail: `${r.status} ${snippet(hget(r.headers, "content-type"))}` };
    },
    K05: async () => {
      const r = await exchange(PX, build(PX, { path: PX.path }));
      return { ok: r.status === 200 && (hget(r.headers, "content-type") || "").includes("text/html"), detail: `${PX.url.href} → ${describe(r)}` };
    },

    A01: reject([404], { path: "/internal/events" }),
    A02: reject([404], { method: "POST", path: "/internal/boards/b1/access", headers: [["Content-Type", "application/json"]], body: "{}" }),
    A03: reject([404], { path: "//internal/events" }),
    A04: reject([404], { path: "/INTERNAL/events" }),
    A05: reject([400, 404], { path: "/%2e%2e/internal/events" }),
    A06: reject([404], { path: "/api/boards/../internal/events" }),
    A07: reject([404], { path: "/api/boards/%2e%2e/%2e%2e/internal/boards/b1/access" }),
    A08: reject([404], { path: "/%69nternal/events" }),
    A09: reject([404], { path: "/%2569nternal/events" }),
    A10: reject([404], { path: "/internal%2fevents" }),
    A11: reject([404], { path: "/api/chat/%2569nternal/events" }),

    B01: reject([405], { requestLine: "TRACE / HTTP/1.1" }),
    B02: reject([400, 405], { requestLine: `CONNECT ${T.hostname}:${T.port} HTTP/1.1`, host: `${T.hostname}:${T.port}` }),
    B03: reject([405], { method: "DELETE", path: "/login" }),
    B04: reject([405], { method: "PUT", path: "/api/auth/login", headers: [["Content-Type", "application/json"]], body: "{}" }),

    C01: async (id) => {
      const r = await send(id, { path: "/", host: EVIL_HOST });
      const loc = hget(r.headers, "location");
      return { ...rejected(r, [421]), detail: `${describe(r)}${loc ? ` · Location: ${loc}` : ""}`, rids: [rid(id)] };
    },
    C02: async (id) => {
      const r = await send(id, { requestLine: `GET http://${EVIL_HOST}/ HTTP/1.1` });
      const loc = hget(r.headers, "location");
      return { ...rejected(r, [421]), detail: `${describe(r)}${loc ? ` · Location: ${loc}` : ""}`, rids: [rid(id)] };
    },
    C03: sniffed,
    C04: sniffed,
    C05: sniffed,
    C06: sniffed,
    C07: sniffed,
    C08: async () => {
      const injected = 'abc def" us=200 up=10.0.0.1';
      const r = await exchange(T, build(T, { path: "/api/boards", headers: [["X-Request-ID", injected]] }));
      const echoed = hget(r.headers, "x-request-id") || "";
      return { ok: SAFE_RID.test(echoed) && echoed !== injected, detail: `${r.status} · X-Request-ID devuelto: ${JSON.stringify(echoed)}` };
    },
    C09: (id) => injectedRid(id, `X-Request-ID: ${rid(id)}\r\n X-Inyectada: s2`)(),
    C10: (id) => injectedRid(id, `X-Request-ID: ${rid(id)}\rX-Inyectada: s2`)(),

    D01: reject([413], { method: "POST", path: "/api/boards", headers: [["Content-Type", "application/json"], ["Content-Length", String(2 * 1024 * 1024)]] }),
    D02: reject([400, 431], { path: "/login", headers: [["X-Relleno", "A".repeat(20000)]] }),
    D03: reject([414], { path: `/login?q=${"A".repeat(12000)}` }),
    D04: reject([413], { method: "POST", path: "/api/auth/login", headers: [["Content-Type", "application/json"]], body: JSON.stringify({ email: "x@y.z", password: "p".repeat(100 * 1024) }) }),

    // Slow headers: una cabecera cada 2 s; el gateway debe cortar antes de o.slowMax.
    E01: async (id) => {
      const t0 = Date.now();
      const sock = await openSocket(T);
      const result = await new Promise((resolve) => {
        const chunks = [];
        let n = 0;
        const end = (why) => {
          clearInterval(iv);
          clearTimeout(cap);
          sock.destroy();
          resolve({ why, elapsed: Date.now() - t0, res: parseResponse(Buffer.concat(chunks)) });
        };
        sock.on("data", (c) => chunks.push(c));
        sock.on("close", () => end("cerrada por el gateway"));
        sock.on("error", () => end("cerrada por el gateway"));
        sock.write(`GET /login HTTP/1.1\r\nHost: ${T.host}\r\nX-Request-ID: ${rid(id)}\r\n`);
        const iv = setInterval(() => sock.write(`X-Lento-${++n}: a\r\n`), 2000);
        const cap = setTimeout(() => end("abierta"), o.slowWait * 1000);
      });
      const s = (result.elapsed / 1000).toFixed(1);
      const resp = result.res.status ? ` (respuesta ${result.res.status} ${(hget(result.res.headers, "content-type") || "").split(";")[0]})` : " (sin respuesta)";
      return result.why === "abierta"
        ? { ok: false, detail: `la conexión seguía abierta a los ${s} s` }
        : { ok: result.elapsed <= o.slowMax * 1000, detail: `cerrada por el gateway a los ${s} s${resp}` };
    },
    // Slow body: cabeceras completas, 10 de 1000 bytes y silencio.
    E02: async (id) => {
      const t0 = Date.now();
      const sock = await openSocket(T);
      const result = await new Promise((resolve) => {
        const chunks = [];
        const end = (why) => {
          clearTimeout(cap);
          sock.destroy();
          resolve({ why, elapsed: Date.now() - t0, res: parseResponse(Buffer.concat(chunks)) });
        };
        sock.on("data", (c) => chunks.push(c));
        sock.on("close", () => end("cerrada"));
        sock.on("error", () => end("cerrada"));
        sock.write(build(T, { method: "POST", path: "/api/boards", rid: rid(id), headers: [["Content-Type", "application/json"], ["Content-Length", "1000"]] }));
        sock.write('{"name":"x');
        const cap = setTimeout(() => end("abierta"), o.slowWait * 1000);
      });
      const s = (result.elapsed / 1000).toFixed(1);
      if (result.why === "abierta") return { ok: false, detail: `la conexión seguía abierta a los ${s} s`, rids: [rid(id)] };
      const res = result.res;
      const bodyOk = res.status == null || isGatewayJson(res);
      return { ok: result.elapsed <= o.slowMax * 1000 && bodyOk, detail: `cerrada a los ${s} s (${res.status ? describe(res) : "sin respuesta"})`, rids: [rid(id)] };
    },
    // Muchas conexiones con el cuerpo pendiente: limit_conn debe rechazar las que sobran.
    E03: async (id) => {
      const n = o.conns;
      const socks = [];
      // Una conexión cada 50 ms (20/s): por debajo de la tasa de limit_req de la zona api
      // (30 r/s), así un rechazo solo puede venir del límite de conexiones simultáneas.
      const results = await Promise.all(
        Array.from({ length: n }, async (_, i) => {
          await sleep(i * 50);
          let sock;
          try {
            sock = await openSocket(T);
          } catch (e) {
            return { error: e.code || e.message };
          }
          socks.push(sock);
          return new Promise((resolve) => {
            const chunks = [];
            const end = () => resolve(parseResponse(Buffer.concat(chunks)));
            sock.on("data", (c) => chunks.push(c));
            sock.on("close", end);
            sock.on("error", end);
            sock.write(build(T, { method: "POST", path: "/api/boards", rid: `${rid(id)}-${i}`, headers: [["Content-Type", "application/json"], ["Content-Length", "100"]] }));
            setTimeout(end, 4000);
          });
        }),
      );
      socks.forEach((s) => s.destroy());
      const answered = results.map((r, i) => ({ r, i })).filter(({ r }) => r && r.status);
      const limited = answered.filter(({ r }) => r.status === 429 || r.status === 503);
      const allJson = limited.every(({ r }) => isGatewayJson(r));
      const codes = {};
      answered.forEach(({ r }) => (codes[r.status] = (codes[r.status] || 0) + 1));
      return {
        ok: limited.length > 0 && allJson,
        detail: `${limited.length}/${n} rechazadas al instante (${JSON.stringify(codes)}); ${n - answered.length} retenidas por el gateway esperando el cuerpo${limited.length && !allJson ? " · rechazo sin JSON" : ""}`,
        rids: limited.map(({ i }) => `${rid(id)}-${i}`),
      };
    },
    // Ráfaga contra la web: debe aparecer 429 JSON con las cabeceras de seguridad (herencia de add_header).
    E04: async (id) => {
      const items = Array.from({ length: o.burst }, (_, i) => i);
      const results = await pool(items, o.concurrency, (i) => exchange(T, build(T, { path: "/login", rid: `${rid(id)}-${i}` })));
      const codes = {};
      results.forEach((r) => (codes[r.status ?? "sin"] = (codes[r.status ?? "sin"] || 0) + 1));
      const limitedIdx = results.map((r, i) => (r.status === 429 ? i : -1)).filter((i) => i >= 0);
      if (!limitedIdx.length) return { ok: false, detail: `0/${o.burst} limitadas: ${JSON.stringify(codes)}` };
      const sample = results[limitedIdx[0]];
      const missing = SECURITY_HEADERS.filter((h) => hall(sample.headers, h).length !== 1);
      if (T.https && hall(sample.headers, "strict-transport-security").length !== 1) missing.push("strict-transport-security");
      const json = limitedIdx.every((i) => isGatewayJson(results[i]));
      return {
        ok: json && missing.length === 0,
        detail: `${limitedIdx.length}/${o.burst} limitadas: ${JSON.stringify(codes)}${json ? "" : " · 429 sin JSON"}${missing.length ? ` · al 429 le faltan: ${missing.join(", ")}` : ""}`,
        rids: limitedIdx.map((i) => `${rid(id)}-${i}`),
      };
    },

    // Slow read: el cliente pide un archivo grande y no lo lee. Desde el host no se puede medir
    // (el proxy de puertos de Docker Desktop lee por su cuenta): corre en un contenedor de la red
    // edge, con SO_RCVBUF mínimo, contra el puerto interno del gateway.
    E05: async (id) => {
      if (!o.docker) return { ok: false, detail: "requiere Docker (--no-docker)" };
      const page = await exchange(T, build(T, { path: "/login" }));
      const chunks = [...new Set(page.body.match(/\/_next\/static\/[A-Za-z0-9_./~-]+\.js/g) || [])].slice(0, 40);
      let best = null;
      for (const c of chunks) {
        const h = await exchange(T, build(T, { method: "HEAD", path: c }));
        const len = Number(hget(h.headers, "content-length") || 0);
        if (!best || len > best.len) best = { path: c, len };
      }
      if (!best || best.len < 50000) return { ok: false, detail: `no hay un estático de ≥ 50 KB para la prueba (${best ? best.len : 0} B)` };
      const gw = compose(o.composeDir, ["ps", "-q", "gateway"]).trim();
      const nets = JSON.parse(execFileSync("docker", ["inspect", gw, "--format", "{{json .NetworkSettings.Networks}}"], { encoding: "utf8" }));
      const edge = Object.keys(nets).find((n) => n.endsWith("_edge")) || Object.keys(nets)[0];
      const py = [
        "import json,socket,ssl,sys,time",
        "host,port,https,hosthdr,path,rid,wait=sys.argv[1],int(sys.argv[2]),sys.argv[3]=='1',sys.argv[4],sys.argv[5],sys.argv[6],float(sys.argv[7])",
        "s=socket.socket();s.setsockopt(socket.SOL_SOCKET,socket.SO_RCVBUF,1024);s.connect((host,port))",
        "if https:\n c=ssl.create_default_context();c.check_hostname=False;c.verify_mode=ssl.CERT_NONE;c.set_alpn_protocols(['http/1.1']);s=c.wrap_socket(s,server_hostname='localhost')",
        "s.sendall(('GET %s HTTP/1.1\\r\\nHost: %s\\r\\nUser-Agent: s2-proxy/1.0\\r\\nX-Request-ID: %s\\r\\nConnection: close\\r\\n\\r\\n'%(path,hosthdr,rid)).encode())",
        "time.sleep(wait)",
        "s.settimeout(5);data=b'';end='timeout'",
        "try:\n while True:\n  b=s.recv(65536)\n  if not b:\n   end='cerrada';break\n  data+=b\nexcept (ConnectionResetError,ssl.SSLError,OSError) as e:\n end='reset' if not isinstance(e,socket.timeout) else 'timeout'",
        "head,_,body=data.partition(b'\\r\\n\\r\\n')",
        "print(json.dumps({'fin':end,'status_line':head.split(b'\\r\\n')[0].decode('latin1'),'cuerpo':len(body)}))",
      ].join("\n");
      const t0 = Date.now();
      const out = execFileSync(
        "docker",
        ["run", "--rm", "--network", edge, "python:3.12-slim", "python", "-c", py, "gateway", String(T.https ? 443 : 80), T.https ? "1" : "0", T.host, best.path, rid(id), String(o.slowWait)],
        { encoding: "utf8", timeout: (o.slowWait + 60) * 1000 },
      );
      const r = JSON.parse(out.trim().split(/\r?\n/).pop());
      // Corte = cuerpo incompleto y conexión terminada por el gateway. (Nginx registra el
      // «client timed out … while sending» en nivel info; el error_log del gateway está en warn.)
      const truncated = r.cuerpo < best.len;
      return {
        ok: truncated && r.fin !== "timeout",
        detail: `${best.path} (${best.len} B): tras ${o.slowWait} s sin leer se recibieron ${r.cuerpo} B y la conexión terminó «${r.fin}» (${r.status_line || "sin cabeceras"}) en ${((Date.now() - t0) / 1000).toFixed(1)} s`,
      };
    },
    // Muchos WebSocket abiertos a la vez: el límite propio de WS (conn_ws) debe rechazar los que sobran.
    E06: async (id) => {
      const n = o.wsConns;
      const socks = [];
      const results = await Promise.all(
        Array.from({ length: n }, async (_, i) => {
          await sleep(i * 50);
          let sock;
          try {
            sock = await openSocket(T);
          } catch (e) {
            return { error: e.code || e.message };
          }
          socks.push(sock);
          return new Promise((resolve) => {
            const chunks = [];
            let done = false;
            const end = () => {
              if (done) return;
              done = true;
              resolve(parseResponse(Buffer.concat(chunks)));
            };
            sock.on("data", (c) => {
              chunks.push(c);
              const buf = Buffer.concat(chunks);
              const sep = buf.indexOf("\r\n\r\n");
              if (sep < 0) return;
              const head = buf.subarray(0, sep).toString("latin1");
              // 101: el WebSocket queda abierto (y cuenta en el límite) hasta el final del caso.
              if (/^HTTP\/1\.1 101/.test(head)) return end();
              // Rechazo: se espera el cuerpo completo (las respuestas del gateway llevan Content-Length).
              const len = Number((/\r\ncontent-length: *(\d+)/i.exec(head) || [])[1]);
              if (Number.isFinite(len) && buf.length >= sep + 4 + len) end();
            });
            sock.on("close", end);
            sock.on("error", end);
            sock.write(
              build(T, {
                path: "/ws/pixels",
                rid: `${rid(id)}-${i}`,
                headers: [
                  ["Upgrade", "websocket"],
                  ["Connection", "Upgrade"],
                  ["Sec-WebSocket-Version", "13"],
                  ["Sec-WebSocket-Key", randomBytes(16).toString("base64")],
                ],
              }).toString("latin1").replace("Connection: close\r\n", ""),
            );
            setTimeout(end, 4000);
          });
        }),
      );
      await sleep(500);
      socks.forEach((s) => s.destroy());
      const codes = {};
      results.forEach((r) => (codes[r?.status ?? "sin"] = (codes[r?.status ?? "sin"] || 0) + 1));
      const limited = results.map((r, i) => ({ r, i })).filter(({ r }) => r?.status === 429);
      const allJson = limited.every(({ r }) => isGatewayJson(r));
      return {
        ok: limited.length > 0 && allJson,
        detail: `${limited.length}/${n} WebSocket rechazados (${JSON.stringify(codes)})${limited.length && !allJson ? " · rechazo sin JSON" : ""}`,
        rids: limited.map(({ i }) => `${rid(id)}-${i}`),
      };
    },

    F01: reject([404], { path: "/s2-no-existe" }),
    F02: reject([404], { path: "/api/s2-no-existe" }),
    F03: reject([404], { path: "/api/canvas/boards/b1/otra-cosa" }),
    F04: async () => {
      const targets = [
        [T, "/login"],
        [T, "/api/boards"],
        [T, "/api/auth/me"],
        [T, "/api/pixels/board"],
        [T, "/api/notifications"],
        [T, "/api/chat/boards/b1/messages"],
        [T, "/s2-no-existe"],
        [PX, PX.path],
      ];
      const findings = [];
      for (const [ep, p] of targets) {
        const r = await exchange(ep, build(ep, { path: p }));
        const where = ep === PX ? `UI de Pixels ${ep.host}${p}` : p;
        for (const s of hall(r.headers, "server")) if (s.toLowerCase() !== "nginx") findings.push(`${where}: server=${s}`);
        for (const [k, v] of r.headers) if (STACK_HEADERS.includes(k) || STACK_PREFIXES.some((pre) => k.startsWith(pre))) findings.push(`${where}: ${k}=${snippet(v, 30)}`);
      }
      return { ok: findings.length === 0, detail: findings.length ? findings.join(" · ") : "solo «Server: nginx» sin versión" };
    },
    F05: async () => {
      const targets = [
        [T, "/login"],
        [T, "/api/boards"],
        [T, "/s2-no-existe"],
        [PX, PX.path],
      ];
      const problems = [];
      for (const [ep, p] of targets) {
        const r = await exchange(ep, build(ep, { path: p }));
        const where = ep === PX ? "UI de Pixels" : p;
        const bad = [];
        for (const h of SECURITY_HEADERS) {
          const n = hall(r.headers, h).length;
          if (n !== 1) bad.push(n ? `${h}×${n}` : `sin ${h}`);
        }
        const csp = hget(r.headers, "content-security-policy") || "";
        if (csp && !/frame-ancestors/i.test(csp)) bad.push("CSP sin frame-ancestors");
        const xcto = hget(r.headers, "x-content-type-options");
        if (xcto && xcto.toLowerCase() !== "nosniff") bad.push(`x-content-type-options=${xcto}`);
        if (ep.https && hall(r.headers, "strict-transport-security").length !== 1) bad.push(`HSTS×${hall(r.headers, "strict-transport-security").length}`);
        if (bad.length) problems.push(`${where} (${r.status}): ${bad.join(", ")}`);
      }
      return { ok: problems.length === 0, detail: problems.length ? problems.join(" · ") : "todas presentes una vez en las 4 respuestas" };
    },
    // Fuente de verdad: lo que publica Docker para este stack. El sondeo TCP confirma qué responde;
    // un puerto abierto que el stack no publica es de otro proceso del host y no cuenta.
    F06: async () => {
      const allowed = new Set(o.allowedPorts);
      const allowedPub = (port, ip) => allowed.has(port) || (port === 15672 && ip === "127.0.0.1");
      let published = null;
      if (o.docker) {
        try {
          published = compose(o.composeDir, ["ps", "--format", "json"])
            .split(/\r?\n/)
            .filter(Boolean)
            .flatMap((l) => [].concat(JSON.parse(l)))
            .flatMap((r) => (r.Publishers || []).filter((p) => p.PublishedPort).map((p) => ({ service: r.Service, ip: p.URL || "0.0.0.0", port: p.PublishedPort, target: p.TargetPort })))
            .filter((p, i, all) => all.findIndex((q) => q.service === p.service && q.port === p.port && (q.ip === "::") === (p.ip === "::")) === i)
            .filter((p) => p.ip !== "::");
        } catch {
          published = null;
        }
      }
      const lan = Object.values(os.networkInterfaces())
        .flat()
        .filter((i) => i && i.family === "IPv4" && !i.internal && !i.address.startsWith("169.254."))
        .map((i) => i.address);
      const hosts = ["127.0.0.1", ...new Set(lan)];
      const pubPorts = new Set((published || []).map((p) => p.port));
      const ports = [...new Set([...PROBE_PORTS, ...pubPorts])];
      const open = [];
      await Promise.all(hosts.flatMap((h) => ports.map(async (port) => (await probe(h, port)) && open.push({ h, port }))));
      const badPub = (published || []).filter((p) => !allowedPub(p.port, p.ip));
      const ofStack = (x) => published == null || pubPorts.has(x.port);
      const badOpen = open.filter((x) => ofStack(x) && !allowedPub(x.port, x.h));
      const foreign = published ? [...new Set(open.filter((x) => !pubPorts.has(x.port)).map((x) => x.port))].sort((a, b) => a - b) : [];
      // Las IP de la máquina (LAN, adaptadores virtuales) se enmascaran: la evidencia se versiona.
      const mask = (ip) => (ip === "127.0.0.1" || ip === "0.0.0.0" ? ip : ip.split(".").slice(0, 2).concat("x", "x").join("."));
      const fmtPub = (l) => l.map((p) => `${p.service} ${p.ip}:${p.port}→${p.target}`).join(", ") || "ninguno";
      const fmtOpen = (l) => l.map(({ h, port }) => `${mask(h)}:${port}`).sort().join(", ") || "ninguno";
      return {
        ok: badPub.length === 0 && badOpen.length === 0,
        detail: [
          published ? `publicados por el stack: ${fmtPub(published)}` : "sin Docker: solo sondeo TCP",
          `indebidos: ${fmtPub(badPub)}`,
          `responden por TCP sin estar permitidos: ${fmtOpen(badOpen)}`,
          foreign.length ? `abiertos por procesos del host ajenos al stack (no cuentan): ${foreign.join(", ")}` : null,
          `IP probadas: ${hosts.map(mask).join(", ")}`,
        ]
          .filter(Boolean)
          .join(" · "),
      };
    },
  };
}

// ---------------------------------------------------------------- verificación en el access log
function checkUpstream(entries, { access: lines, errors }) {
  for (const e of entries) {
    const meta = CATALOGO.find((c) => c.id === e.id);
    // E03 / E06: el rechazo debe venir del límite de conexiones de su zona, no del de tasa.
    const connZone = { E03: "conn", E06: "conn_ws" }[e.id];
    if (connZone) {
      const inWindow = errors.filter((x) => x.time >= Math.floor(e.t0 / 1000) * 1000 && x.time <= e.t1 + 1000);
      const byConn = inWindow.filter((x) => x.kind === "limiting connections" && x.zone === connZone).length;
      const byRate = inWindow.filter((x) => x.kind === "limiting requests").length;
      e.detail += ` · error log: ${byConn} «limiting connections» (zona ${connZone}), ${byRate} «limiting requests»`;
      if (byRate > 0 || (e.ok && byConn === 0)) e.ok = false;
    }
    if (meta.verif !== "log" || !e.rids?.length) {
      e.upstream = meta.verif === "captura" ? "llega saneada (captura)" : "n/a";
      continue;
    }
    const wanted = new Set(e.rids);
    let matched = lines.filter((l) => wanted.has(l.rid));
    let how = "rid";
    // Peticiones que el gateway rechaza al leer la línea de petición (p. ej. 400 por /%2e%2e/)
    // no llegan a leer X-Request-ID: se buscan en el segundo propio del caso (aislar), con su
    // estado y su "método uri", descartando las líneas de cualquier otro caso (rid s2-*).
    if (!matched.length && e.status && meta.logHint) {
      const from = Math.floor(e.t0 / 1000) * 1000;
      const to = Math.floor(e.t1 / 1000) * 1000;
      matched = lines.filter((l) => !l.rid.startsWith("s2-") && l.status === e.status && l.time >= from && l.time <= to && meta.logHint.some(([m, u]) => l.method === m && l.uri === u));
      how = "ventana";
    }
    // Un rechazo que no deja línea no está verificado: cuenta como FAIL.
    if (!matched.length) {
      e.upstream = "sin línea en el log (no verificado)";
      e.ok = false;
      continue;
    }
    e.log = matched.slice(0, 3).map((l) => l.line);
    const reached = matched.filter((l) => l.us !== "-");
    e.upstream = reached.length ? `SÍ (us=${reached[0].us})` : `no (us=- en ${matched.length} línea${matched.length > 1 ? "s" : ""}${how === "ventana" ? ", por ventana de tiempo" : ""})`;
    if (reached.length) e.ok = false;
  }
}

// ---------------------------------------------------------------- principal
function parseArgs(argv) {
  const o = {
    target: "https://localhost:8443",
    ca: process.env.S2_CA || null,
    pixelsUi: null,
    composeDir: process.cwd(),
    docker: true,
    json: null,
    label: "",
    slowWait: 25,
    slowMax: 15,
    conns: 120,
    wsConns: 40,
    burst: 300,
    concurrency: 30,
    allowedPorts: [8088, 8443],
    only: null,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const v = () => argv[++i];
    switch (a) {
      case "--target": o.target = v(); break;
      case "--ca": o.ca = v(); break;
      case "--pixels-ui": o.pixelsUi = v(); break;
      case "--compose-dir": o.composeDir = path.resolve(v()); break;
      case "--no-docker": o.docker = false; break;
      case "--json": o.json = v(); break;
      case "--label": o.label = v(); break;
      case "--slow-wait": o.slowWait = Number(v()); break;
      case "--slow-max": o.slowMax = Number(v()); break;
      case "--conns": o.conns = Number(v()); break;
      case "--ws-conns": o.wsConns = Number(v()); break;
      case "--burst": o.burst = Number(v()); break;
      case "--concurrency": o.concurrency = Number(v()); break;
      case "--allowed-ports": o.allowedPorts = v().split(",").map(Number); break;
      case "--only": o.only = new Set(v().split(",")); break;
      case "--help":
        console.log(`Uso: node security-tests/s2_proxy.mjs [opciones]
  --target URL          gateway (por defecto https://localhost:8443)
  --ca ARCHIVO          CA para HTTPS (por defecto gateway/certs/ca.crt si existe, o S2_CA)
  --pixels-ui URL       UI de Pixels (por defecto <target>/pixels/)
  --compose-dir DIR     carpeta del stack para leer el log y capturar (por defecto la actual)
  --no-docker           sin log ni captura (los casos de captura fallan; us=- queda sin verificar)
  --json ARCHIVO        guarda los resultados
  --label TEXTO         etiqueta de la corrida (p. ej. "P2 6af0456")
  --slow-wait S / --slow-max S   espera máxima y umbral de corte en E01/E02 (25 / 15)
  --conns N             conexiones simultáneas en E03 (120)
  --ws-conns N          WebSocket simultáneos en E06 (40)
  --burst N --concurrency N      ráfaga de E04 (300 / 30)
  --allowed-ports L     puertos del gateway permitidos en el host (8088,8443)
  --only IDS            solo estos casos (A01,C03,...)`);
        process.exit(0);
        break;
      default:
        console.error(`Opción desconocida: ${a} (ver --help)`);
        process.exit(2);
    }
  }
  return o;
}

async function main() {
  const o = parseArgs(process.argv);
  const T = endpoint(o.target);
  const PX = endpoint(o.pixelsUi || new URL("/pixels/", o.target).href);
  if (!o.ca && (T.https || PX.https) && !process.env.NODE_EXTRA_CA_CERTS && fs.existsSync("gateway/certs/ca.crt")) o.ca = "gateway/certs/ca.crt";
  if (o.ca) CA = fs.readFileSync(o.ca);

  const tag = randomBytes(3).toString("hex");
  const rid = (id) => `s2-${id}-${tag}`;
  const ctx = { T, PX, tag, rid, o, capture: null, sniffRes: {}, packets: {} };
  const runners = makeRunners(ctx);
  const selected = CATALOGO.filter((c) => !o.only || o.only.has(c.id));
  const started = Date.now();
  console.log(`S2 · Reverse Proxy — ${selected.length} casos contra ${T.url.origin}${o.label ? ` (${o.label})` : ""} · corrida ${tag}`);
  console.log(`UI de Pixels: ${PX.url.href} · log/captura: ${o.docker ? o.composeDir : "desactivados"}\n`);

  const entries = [];
  const run = async (meta) => {
    // Casos sin X-Request-ID legible: se ejecutan solos en su segundo (el log tiene resolución de 1 s).
    if (meta.aislar) await sleep(1100 - (Date.now() % 1000) + 50);
    const t0 = Date.now();
    let r;
    try {
      r = await runners[meta.id](meta.id);
    } catch (e) {
      r = { ok: false, detail: `error del script: ${e.message}` };
    }
    const status = /^(\d{3})\b/.exec(r.detail || "")?.[1];
    entries.push({ ...meta, ...r, status: status ? Number(status) : null, t0, t1: Date.now() });
    process.stderr.write(`  · ${meta.id} ${r.ok ? "ok" : "falla"}\n`);
    if (meta.aislar) await sleep(1100 - (Date.now() % 1000) + 50);
  };

  const byId = (ids) => selected.filter((c) => ids.includes(c.id));
  const sniffIds = ["C03", "C04", "C05", "C06", "C07"];
  const slowIds = ["E01", "E02", "E05"];
  // E04 va al final: deja agotada la zona web unos segundos.
  const lastIds = ["E03", "E06", "E04"];
  const plain = selected.filter((c) => !sniffIds.includes(c.id) && !slowIds.includes(c.id) && !lastIds.includes(c.id));

  for (const meta of plain) await run(meta);

  const sniffCases = byId(sniffIds);
  if (sniffCases.length) {
    let cap = null;
    if (o.docker) {
      try {
        cap = await startCapture(o.composeDir, tag);
      } catch (e) {
        console.error(`Captura no disponible: ${e.message}`);
      }
    }
    // Se envían las peticiones con tcpdump activo y se evalúan con la captura ya cerrada.
    for (const meta of sniffCases) await ctx.sniffFire(meta.id);
    ctx.capture = cap ? await cap.stop() : null;
    for (const meta of sniffCases) await run(meta);
  }

  await Promise.all(byId(slowIds).map(run));
  for (const meta of byId(lastIds)) await run(meta);

  const finished = Date.now();
  if (o.docker) {
    try {
      checkUpstream(entries, readGatewayLog(o.composeDir, started));
    } catch (e) {
      console.error(`No se pudo leer el log del gateway: ${e.message}`);
      entries.forEach((e) => (e.upstream = e.verif === "log" ? "sin verificar (log no disponible)" : "n/a"));
    }
  } else {
    entries.forEach((e) => (e.upstream = e.verif === "log" ? "sin verificar (--no-docker)" : "n/a"));
  }

  const order = new Map(CATALOGO.map((c, i) => [c.id, i]));
  entries.sort((a, b) => order.get(a.id) - order.get(b.id));
  console.log("");
  for (const e of entries) {
    const up = e.verif === "log" ? ` · upstream: ${e.upstream}` : "";
    console.log(`${e.ok ? "OK  " : "FAIL"} ${e.id} [${e.cat}] ${e.peticion}\n       → ${e.detail}${up}`);
  }
  const attacks = entries.filter((e) => e.tipo !== "control");
  const controls = entries.filter((e) => e.tipo === "control");
  const ok = (l) => l.filter((e) => e.ok).length;
  const verified = attacks.filter((e) => e.verif === "log" && /^no \(us=-/.test(e.upstream || "")).length;
  const logCases = attacks.filter((e) => e.verif === "log").length;
  console.log(`\nAtaques bloqueados o normalizados: ${ok(attacks)}/${attacks.length} · controles: ${ok(controls)}/${controls.length} · rechazos con us=- en el log: ${verified}/${logCases}`);

  if (o.json) {
    const out = {
      herramienta: "security-tests/s2_proxy.mjs",
      objetivo: T.url.origin,
      ui_pixels: PX.url.href,
      etiqueta: o.label,
      corrida: tag,
      inicio: new Date(started).toISOString(),
      fin: new Date(finished).toISOString(),
      node: process.version,
      resumen: { ataques_ok: ok(attacks), ataques: attacks.length, controles_ok: ok(controls), controles: controls.length, rechazos_us_guion: verified, rechazos_con_log: logCases },
      resultados: entries.map(({ t0, t1, rids, ...rest }) => ({
        ...rest,
        rids: rids?.length > 5 ? [...rids.slice(0, 5), `… (${rids.length})`] : rids,
        // Paquete del tramo interno gateway -> servicio con la petición del caso (solo C03–C07).
        captura: ctx.packets[rest.id],
      })),
    };
    fs.mkdirSync(path.dirname(path.resolve(o.json)), { recursive: true });
    fs.writeFileSync(o.json, JSON.stringify(out, null, 2) + "\n");
    console.log(`Resultados: ${o.json}`);
  }
  process.exit(entries.every((e) => e.ok) ? 0 : 1);
}

if (path.resolve(process.argv[1] || "").toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  main().catch((e) => {
    console.error(e);
    process.exit(2);
  });
}
