// Prueba de WebSocket a través del gateway (Node >= 22, sin dependencias).
//   node scripts/ws_check.mjs [http://localhost:8088]
// Verifica: (1) cada WS publicado hace el Upgrade 101 y el servicio responde;
// (2) autenticación por cookie y por Authorization: Bearer (como otros clientes);
// (3) que /internal/* devuelve 404 desde fuera.
const base = (process.argv[2] || "http://localhost:8088").replace(/\/$/, "");
const wsBase = base.replace(/^http/, "ws");

let failures = 0;
const log = (ok, name, extra = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "OK  " : "FAIL"} ${name}${extra ? " — " + extra : ""}`);
};

async function http(path, init = {}) {
  const res = await fetch(base + path, { redirect: "manual", ...init });
  const text = await res.text();
  return { status: res.status, text, headers: res.headers };
}

/** Abre un WS y devuelve {opened, code, messages}. */
function openWs(path, { headers = {}, sendOnOpen, waitMs = 2500 } = {}) {
  return new Promise((resolve) => {
    const out = { opened: false, code: null, messages: [] };
    const ws = new WebSocket(wsBase + path, { headers });
    const done = () => {
      try { ws.close(); } catch { /* ya cerrado */ }
      resolve(out);
    };
    const timer = setTimeout(done, waitMs);
    ws.onopen = () => {
      out.opened = true;
      if (sendOnOpen) ws.send(sendOnOpen);
    };
    ws.onmessage = (e) => out.messages.push(String(e.data));
    ws.onclose = (e) => { out.code = e.code; clearTimeout(timer); resolve(out); };
    ws.onerror = () => {};
  });
}

const suffix = Math.random().toString(36).slice(2, 8);
const creds = { name: `WS ${suffix}`, email: `ws-${suffix}@ejemplo.com`, password: "WsCheck-Password-123", confirm_password: "WsCheck-Password-123" };

const reg = await http("/api/auth/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(creds) });
log(reg.status === 201 || reg.status === 200, "registro por /api/auth/register", `status ${reg.status}`);
const token = JSON.parse(reg.text || "{}").access_token;
if (!token) { console.log(reg.text); process.exit(1); }
const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

const created = await http("/api/boards", { method: "POST", headers: auth, body: JSON.stringify({ name: "WS check" }) });
log(created.status === 201, "crear tablero por /api/boards", `status ${created.status}`);
const boardId = JSON.parse(created.text || "{}").id || "00000000-0000-0000-0000-000000000000";

// /internal nunca se publica
for (const p of ["/internal/events", "/api/internal/events", "/api/chat/internal/x", "/api/boards/internal/access"]) {
  const r = await http(p, { method: "POST" });
  log(r.status === 404, `bloqueado ${p}`, `status ${r.status}`);
}

// Pizarra: cookie (navegador) y cabecera Authorization. Con tablero real en Colaboración
// y Pizarra aún con su propia copia, el cierre 4403 indica que el servicio SÍ recibió el JWT.
const pizarraCookie = await openWs(`/ws/boards/${boardId}`, { headers: { Cookie: `cb_session=${token}` } });
log(pizarraCookie.opened, "WS Pizarra con cookie: Upgrade 101", `cierre=${pizarraCookie.code}`);
const pizarraBearer = await openWs(`/ws/boards/${boardId}`, { headers: { Authorization: `Bearer ${token}` } });
log(pizarraBearer.opened, "WS Pizarra con Bearer: Upgrade 101", `cierre=${pizarraBearer.code}`);
const pizarraAnon = await openWs(`/ws/boards/${boardId}`);
log(pizarraAnon.code === 4401, "WS Pizarra sin credencial: cierre 4401", `cierre=${pizarraAnon.code}`);

// Chat: la cookie solo se acepta con un Origin permitido (política del servicio);
// con Authorization puede omitirse el Origin.
const origin = base;
const chat = await openWs(`/ws/chat/boards/${boardId}`, { headers: { Cookie: `cb_session=${token}`, Origin: origin }, sendOnOpen: '{"type":"ping"}' });
log(chat.opened && chat.messages.some((m) => m.includes("pong")), "WS Chat con cookie + Origin permitido: ping/pong", `cierre=${chat.code} msgs=${JSON.stringify(chat.messages)}`);
const chatNoOrigin = await openWs(`/ws/chat/boards/${boardId}`, { headers: { Cookie: `cb_session=${token}` } });
log(!chatNoOrigin.opened, "WS Chat con cookie sin Origin: rechazado");
const chatEvil = await openWs(`/ws/chat/boards/${boardId}`, { headers: { Cookie: `cb_session=${token}`, Origin: "http://evil.example" } });
log(!chatEvil.opened, "WS Chat con cookie y Origin ajeno: rechazado");
const chatBearer = await openWs(`/ws/chat/boards/${boardId}`, { headers: { Authorization: `Bearer ${token}` }, sendOnOpen: '{"type":"ping"}' });
log(chatBearer.opened && chatBearer.messages.some((m) => m.includes("pong")), "WS Chat con Bearer: ping/pong", `msgs=${JSON.stringify(chatBearer.messages)}`);

// Pixels
const pixels = await openWs("/ws/pixels", { waitMs: 2000 });
log(pixels.opened, "WS Pixels: Upgrade 101", `msgs=${pixels.messages.length}`);

console.log(failures === 0 ? "\nTodas las comprobaciones pasaron." : `\n${failures} comprobación(es) fallaron.`);
process.exit(failures === 0 ? 0 : 1);
