# Reutilizar la interfaz en el cliente local (Electron)

Guía del paquete A para Sebastian (paquete F). La web SSR separa en `web-ssr/src` dos capas
que **no dependen de Next.js** (lo verifica ESLint):

- `core/`: dominio, transporte, APIs tipadas, tiempo real de Pizarra, chat y bandeja.
- `ui/`: componentes React (dashboard, tablero con lienzo, chat, bandeja, compartir).

El cliente local solo aporta tres adaptadores: **transporte**, **navegación** y **sesión**.

## 1. Seguridad (plan P2, sección 4)

- `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false` y *preload* mínimo.
- El token vive **solo** en el proceso principal. El renderer no lo recibe nunca.
- HTTP con `Authorization: Bearer`; el WebSocket se abre en el proceso principal con la
  credencial en la cabecera del *handshake*. Nunca el token en la URL.
- El proceso principal solo reenvía rutas permitidas: usar `sanitizePublicPath` de
  `core/transport/paths.ts` (la misma lista blanca que el BFF web).

## 2. Contrato del puente

Definido en [`core/transport/electronTransport.ts`](../../web-ssr/src/core/transport/electronTransport.ts)
(`CollaBoardBridge`) y cubierto por pruebas en `core/transport/transport.test.ts`.

```ts
interface CollaBoardBridge {
  request(req: { method; path; body? }): Promise<{ status: number; body: unknown }>;
  socketOpen(path: string): Promise<string>;          // devuelve un id de socket
  socketSend(id: string, data: string): void;
  socketClose(id: string, code?: number, reason?: string): void;
  onSocketEvent(listener: (e: BridgeSocketEvent) => void): () => void;
  auth: { login; register; logout; currentUser };
}
```

## 3. Ejemplo de `preload.ts`

```ts
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("collaboard", {
  request: (req) => ipcRenderer.invoke("cb:request", req),
  socketOpen: (path) => ipcRenderer.invoke("cb:socket-open", path),
  socketSend: (id, data) => ipcRenderer.send("cb:socket-send", id, data),
  socketClose: (id, code, reason) => ipcRenderer.send("cb:socket-close", id, code, reason),
  onSocketEvent: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on("cb:socket-event", handler);
    return () => ipcRenderer.off("cb:socket-event", handler);
  },
  auth: {
    login: (c) => ipcRenderer.invoke("cb:login", c),
    register: (d) => ipcRenderer.invoke("cb:register", d),
    logout: () => ipcRenderer.invoke("cb:logout"),
    currentUser: () => ipcRenderer.invoke("cb:current-user"),
  },
});
```

## 4. Ejemplo de proceso principal (fragmento)

```ts
import { ipcMain, safeStorage } from "electron";
import WebSocket from "ws";
import { sanitizePublicPath, withQuery } from "<ruta>/core/transport/paths";

const GATEWAY = process.env.COLLABOARD_GATEWAY ?? "http://localhost:8088";
let token: string | null = null;                     // persistir cifrado con safeStorage si se desea
const sockets = new Map<string, WebSocket>();

ipcMain.handle("cb:request", async (_e, { method, path, body }) => {
  const safe = sanitizePublicPath(path, "api");
  if (!safe || !token) return { status: safe ? 401 : 404, body: { detail: "No permitido" } };
  const res = await fetch(`${GATEWAY}${withQuery(safe, path)}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
});

ipcMain.handle("cb:socket-open", (event, path) => {
  const safe = sanitizePublicPath(path, "ws");
  if (!safe || !token) throw new Error("No permitido");
  const id = crypto.randomUUID();
  const ws = new WebSocket(`${GATEWAY.replace(/^http/, "ws")}${safe}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const emit = (payload) => event.sender.send("cb:socket-event", { id, ...payload });
  ws.on("open", () => emit({ type: "open" }));
  ws.on("message", (data) => emit({ type: "message", data: String(data) }));
  ws.on("error", () => emit({ type: "error" }));
  ws.on("close", (code) => { sockets.delete(id); emit({ type: "close", code }); });
  sockets.set(id, ws);
  return id;
});

ipcMain.on("cb:socket-send", (_e, id, data) => sockets.get(id)?.send(data));
ipcMain.on("cb:socket-close", (_e, id, code, reason) => sockets.get(id)?.close(code, reason));
// cb:login -> POST {GATEWAY}/api/auth/login, guarda access_token y devuelve { id, name }.
```

## 5. Montar la interfaz en el renderer

```tsx
import { createElectronTransport } from "<ruta>/core/transport/electronTransport";
import { AppProvider } from "<ruta>/ui/AppContext";
import { NavigationProvider } from "<ruta>/ui/navigation";
import { DashboardView } from "<ruta>/ui/dashboard/DashboardView";
import { BoardWorkspace } from "<ruta>/ui/board/BoardWorkspace";
import { CanvasBoard } from "<ruta>/ui/canvas/CanvasBoard";

const transport = createElectronTransport(window.collaboard);

<NavigationProvider value={miNavegacion /* { Link, push, replace, refresh } */}>
  <AppProvider transport={transport} user={usuario} config={{ pixelsUrl: null }} onUnauthorized={irAlLogin}>
    {/* Dashboard: pedir los tableros con useApis().boards.list() y pasarlos como initialBoards */}
    <BoardWorkspace
      board={tablero}
      canvas={<CanvasBoard authorId={usuario.id} readOnly={tablero.my_role === "viewer"} />}
    />
  </AppProvider>
</NavigationProvider>
```

Notas:

- Importar `app/globals.css` y `app/collaboard-p2.css` para el mismo aspecto visual.
- En Electron el lienzo se importa directo (el renderer siempre es cliente).
- Para empaquetar, un alias de Vite `@` → `web-ssr/src` (o copiar `core/` y `ui/` en el build)
  permite usar los mismos módulos sin duplicarlos.
- **Pendiente en Pizarra**: el WebSocket de dibujo hoy solo lee `?token=`; para Electron debe
  aceptar `Authorization: Bearer` (coordinar con David y Marlon).
