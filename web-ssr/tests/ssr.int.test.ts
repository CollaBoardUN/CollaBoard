/**
 * Integración SSR sin Docker: arranca el servidor Next compilado (standalone)
 * contra un gateway falso en memoria y comprueba los criterios de aceptación
 * del paquete A del plan P2 sobre el HTML que entrega el servidor.
 *
 *     npm run build && npm run test:ssr
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..");
const SERVER = join(ROOT, ".next", "standalone", "server.js");

function token(sub: string, name: string): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub, name, exp: Math.floor(Date.now() / 1000) + 3600 })}.firma-${sub}`;
}

const USERS: Record<string, { id: string; name: string; email: string }> = {
  [token("ana", "Ana Gómez")]: { id: "ana", name: "Ana Gómez", email: "ana@collaboard.test" },
  [token("beto", "Beto Ruiz")]: { id: "beto", name: "Beto Ruiz", email: "beto@collaboard.test" },
};
const ANA = Object.keys(USERS)[0];
const BETO = Object.keys(USERS)[1];
const EXPIRED = (() => {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "HS256" })}.${b64({ sub: "ana", exp: 1 })}.x`;
})();

const BOARDS: Record<string, { id: string; name: string; owner_id: string }[]> = {
  ana: [{ id: "b-ana", name: "Mapa de servicios de Ana", owner_id: "ana" }],
  beto: [{ id: "b-beto", name: "Retro privada de Beto", owner_id: "beto" }],
};

const gatewayCalls: { path: string; auth: string | null; requestId: string | null }[] = [];
let failNotifications = false;

function board(b: { id: string; name: string; owner_id: string }) {
  return { ...b, my_role: "owner", member_count: 1, created_at: "2026-10-20T10:00:00Z", updated_at: "2026-10-25T10:00:00Z" };
}

function fakeGateway(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://gateway");
  const auth = req.headers.authorization ?? null;
  gatewayCalls.push({ path: url.pathname, auth, requestId: (req.headers["x-request-id"] as string) ?? null });
  const user = auth ? USERS[auth.replace(/^Bearer /, "")] : undefined;
  const json = (status: number, body: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (!user) return json(401, { detail: "No autenticado" });

  const mine = BOARDS[user.id] ?? [];
  if (url.pathname === "/api/auth/me") return json(200, user);
  if (url.pathname === "/api/boards") return json(200, mine.map(board));
  const boardMatch = url.pathname.match(/^\/api\/boards\/([^/]+)$/);
  if (boardMatch) {
    const found = mine.find((b) => b.id === boardMatch[1]);
    return found ? json(200, board(found)) : json(404, { detail: "Tablero no encontrado" });
  }
  if (url.pathname.startsWith("/api/canvas/boards/")) {
    return json(200, { elements: [], seq: 7, saved_at: "2026-10-25T10:00:00Z" });
  }
  if (url.pathname.startsWith("/api/chat/boards/")) {
    return json(200, {
      items: [
        {
          id: "m1",
          board_id: "b-ana",
          sender_id: "ana",
          sender_name: "Ana Gómez",
          text: "Primer mensaje renderizado en el servidor",
          client_message_id: "c1",
          created_at: "2026-10-25T10:01:00Z",
        },
      ],
      next_cursor: null,
    });
  }
  if (url.pathname === "/api/notifications") {
    if (failNotifications) return json(503, { detail: "caído" });
    return json(200, { items: [], unread_count: user.id === "ana" ? 3 : 0 });
  }
  return json(404, { detail: "Ruta no encontrada" });
}

let gateway: Server;
let web: ChildProcess;
let base = "";

/** Puerto libre elegido por el sistema (en Windows hay rangos reservados por Hyper-V). */
async function freePort(): Promise<number> {
  const probe = createServer().listen(0, "127.0.0.1");
  await new Promise((r) => probe.once("listening", r));
  const { port } = probe.address() as AddressInfo;
  await new Promise((r) => probe.close(r));
  return port;
}

async function waitForServer(url: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // aún arrancando
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`El servidor web no respondió en ${url}`);
}

beforeAll(async () => {
  if (!existsSync(SERVER)) throw new Error("Falta la compilación: ejecuta `npm run build` antes de `npm run test:ssr`.");
  gateway = createServer(fakeGateway).listen(0);
  await new Promise((r) => gateway.once("listening", r));
  const gatewayUrl = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`;

  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  web = spawn(process.execPath, [SERVER], {
    cwd: join(ROOT, ".next", "standalone"),
    env: { ...process.env, PORT: String(port), HOSTNAME: "127.0.0.1", GATEWAY_INTERNAL_URL: gatewayUrl, NODE_ENV: "production" },
    stdio: "ignore",
  });
  await waitForServer(`${base}/healthz`);
}, 60_000);

afterAll(() => {
  web?.kill();
  gateway?.close();
});

const page = (path: string, session?: string) =>
  fetch(`${base}${path}`, { redirect: "manual", headers: session ? { Cookie: `cb_session=${session}` } : {} });

describe("SSR de la web (paquete A)", () => {
  it("el HTML autenticado trae los tableros reales antes de ejecutar JavaScript", async () => {
    const res = await page("/", ANA);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Mapa de servicios de Ana");
    expect(html).toContain('aria-label="Notificaciones, 3 sin leer"');
  });

  it("no mezcla cuentas: cada sesión recibe solo sus datos, aun en paralelo", async () => {
    const [ana, beto] = await Promise.all([page("/", ANA).then((r) => r.text()), page("/", BETO).then((r) => r.text())]);
    expect(ana).toContain("Mapa de servicios de Ana");
    expect(ana).not.toContain("Retro privada de Beto");
    expect(beto).toContain("Retro privada de Beto");
    expect(beto).not.toContain("Mapa de servicios de Ana");
  });

  it("no expone el JWT en el HTML y prohíbe cachear respuestas privadas", async () => {
    const res = await page("/", ANA);
    const html = await res.text();
    expect(html).not.toContain(ANA);
    expect(html).not.toContain("firma-ana");
    expect(res.headers.get("cache-control")).toMatch(/no-store/);
    expect(res.headers.get("cache-control")).toMatch(/private/);
  });

  it("sin sesión, o con sesión vencida, redirige al login sin datos privados", async () => {
    for (const session of [undefined, EXPIRED]) {
      const res = await page("/boards/b-ana", session);
      expect(res.status).toBe(307);
      expect(res.headers.get("location")).toMatch(/\/login\?next=%2Fboards%2Fb-ana$/);
      expect(await res.text()).not.toContain("Mapa de servicios");
    }
  });

  it("un token que Auth rechaza lleva a limpiar la sesión", async () => {
    const forged = token("mallory", "Mallory");
    const res = await page("/", forged);
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toMatch(/\/session\/expired/);
    const cleanup = await page("/session/expired?next=/", forged);
    expect(cleanup.headers.get("set-cookie")).toMatch(/cb_session=;.*Max-Age=0/i);
  });

  it("la página del tablero trae nombre, rol y el primer mensaje del chat", async () => {
    const html = await (await page("/boards/b-ana", ANA)).text();
    expect(html).toContain("<title>Mapa de servicios de Ana · CollaBoard</title>");
    expect(html).toContain("Dueño");
    expect(html).toContain("Primer mensaje renderizado en el servidor");
  });

  it("un tablero ajeno responde 404 sin revelar su nombre", async () => {
    const res = await page("/boards/b-ana", BETO);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("Mapa de servicios de Ana");
  });

  it("si una API opcional falla, la página se sirve igual", async () => {
    failNotifications = true;
    try {
      const res = await page("/", ANA);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("Mapa de servicios de Ana");
    } finally {
      failNotifications = false;
    }
  });

  it("propaga X-Request-Id y el Bearer del usuario al gateway", async () => {
    gatewayCalls.length = 0;
    await fetch(`${base}/`, { headers: { Cookie: `cb_session=${ANA}`, "X-Request-Id": "prueba-correlacion-123" } });
    expect(gatewayCalls.length).toBeGreaterThan(0);
    for (const call of gatewayCalls) {
      expect(call.requestId).toBe("prueba-correlacion-123");
      expect(call.auth).toBe(`Bearer ${ANA}`);
    }
  });

  it("el BFF reenvía con Bearer, bloquea rutas internas y aplica CSRF", async () => {
    const ok = await fetch(`${base}/bff/api/boards`, { headers: { Cookie: `cb_session=${ANA}` } });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual([expect.objectContaining({ id: "b-ana" })]);

    const internal = await fetch(`${base}/bff/api/internal/boards/b-ana/access`, { headers: { Cookie: `cb_session=${ANA}` } });
    expect(internal.status).toBe(404);

    const csrf = await fetch(`${base}/bff/api/boards`, {
      method: "POST",
      headers: { Cookie: `cb_session=${ANA}`, Origin: "https://evil.example", "Content-Type": "application/json", "x-collaboard-client": "web" },
      body: JSON.stringify({ name: "x" }),
    });
    expect(csrf.status).toBe(403);

    const anonymous = await fetch(`${base}/bff/api/boards`);
    expect(anonymous.status).toBe(401);
  });
});
