import { vi } from "vitest";

import { ApiError, createApiClient, errorMessage } from "./apiClient";
import { createElectronTransport, type BridgeSocketEvent, type CollaBoardBridge } from "./electronTransport";
import { sanitizePublicPath } from "./paths";
import { SOCKET_CLOSED, SOCKET_OPEN } from "./types";
import { createWebTransport, sameOriginWsBase, WEB_CLIENT_HEADER } from "./webTransport";

describe("rutas públicas permitidas", () => {
  it.each([
    ["/api/boards", "/api/boards"],
    ["/api/boards/b1/members?x=1", "/api/boards/b1/members"],
    ["/api/canvas/boards/b1/state", "/api/canvas/boards/b1/state"],
    ["/api/notifications/n1/read", "/api/notifications/n1/read"],
  ])("acepta %s", (path, expected) => {
    expect(sanitizePublicPath(path, "api")).toBe(expected);
  });

  it.each([
    "/api/auth/login", // el login no pasa por el BFF
    "/api/boards/../internal/x",
    "/api/internal/boards/b1/access",
    "/internal/boards",
    "/api/boardsx",
    "/api//boards",
    "/api/boards/%2e%2e",
    "api/boards",
    "/ws/boards/b1", // ruta WS por el canal HTTP
  ])("rechaza %s", (path) => {
    expect(sanitizePublicPath(path, "api")).toBeNull();
  });

  it("valida rutas WebSocket aparte", () => {
    expect(sanitizePublicPath("/ws/boards/b1", "ws")).toBe("/ws/boards/b1");
    expect(sanitizePublicPath("/ws/chat/boards/b1", "ws")).toBe("/ws/chat/boards/b1");
    expect(sanitizePublicPath("/ws/internal/x", "ws")).toBeNull();
  });
});

describe("cliente api", () => {
  it("traduce errores de FastAPI, validación 422 y respuestas sin cuerpo", () => {
    expect(errorMessage(403, { detail: "Necesitas rol owner" })).toBe("Necesitas rol owner");
    expect(errorMessage(422, { detail: [{ loc: ["body"], msg: "Campo requerido" }] })).toBe("Campo requerido");
    expect(errorMessage(400, { message: "Mensaje de Java" })).toBe("Mensaje de Java");
    expect(errorMessage(0, null)).toBe("No se pudo conectar con el servidor");
    expect(errorMessage(503, null)).toMatch(/no está disponible/);
  });

  it("avisa el 401 para renovar la sesión y lanza ApiError", async () => {
    const onUnauthorized = vi.fn();
    const api = createApiClient(
      { kind: "web", request: async () => ({ status: 401, body: { detail: "El token expiró" } }), openSocket: vi.fn() },
      { onUnauthorized },
    );
    await expect(api.get("/api/boards")).rejects.toEqual(new ApiError(401, "El token expiró"));
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });
});

describe("transporte web", () => {
  it("llama al BFF del mismo origen con la cookie y la cabecera del cliente, sin token", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify([{ id: "b1" }]), { status: 200 }));
    const transport = createWebTransport({ fetchImpl });
    const result = await transport.request({ method: "POST", path: "/api/boards?x=1", body: { name: "A" } });

    expect(result).toEqual({ status: 200, body: [{ id: "b1" }] });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/bff/api/boards?x=1");
    expect(init.credentials).toBe("same-origin");
    expect(init.headers).toMatchObject({ [WEB_CLIENT_HEADER]: "web", "Content-Type": "application/json" });
    expect(JSON.stringify(init.headers)).not.toMatch(/authorization/i);
  });

  it("devuelve estado 0 si no hay red y tolera respuestas vacías o no JSON", async () => {
    const offline = createWebTransport({ fetchImpl: vi.fn().mockRejectedValue(new TypeError("Failed to fetch")) });
    expect(await offline.request({ method: "GET", path: "/api/boards" })).toEqual({ status: 0, body: null });

    const html = createWebTransport({ fetchImpl: vi.fn(async () => new Response("<h1>502</h1>", { status: 502 })) });
    expect(await html.request({ method: "GET", path: "/api/boards" })).toEqual({
      status: 502,
      body: { detail: "<h1>502</h1>" },
    });
  });

  it("no permite rutas fuera del contrato", async () => {
    const transport = createWebTransport({ fetchImpl: vi.fn() });
    await expect(transport.request({ method: "GET", path: "/api/internal/x" })).rejects.toThrow(/no permitida/);
    expect(() => transport.openSocket("/api/boards")).toThrow(/no permitida/);
  });

  it("abre el WebSocket en el mismo origen (la cookie viaja sola) y sin token en la URL", () => {
    const socketFactory = vi.fn(() => ({}) as never);
    createWebTransport({ socketFactory }).openSocket("/ws/boards/b1");
    expect(socketFactory).toHaveBeenCalledWith(`${sameOriginWsBase(window.location)}/ws/boards/b1`);
    expect(sameOriginWsBase({ protocol: "https:", host: "collaboard.app" })).toBe("wss://collaboard.app");

    createWebTransport({ socketFactory, wsBase: "ws://localhost:8088/" }).openSocket("/ws/chat/boards/b1");
    expect(socketFactory).toHaveBeenLastCalledWith("ws://localhost:8088/ws/chat/boards/b1");
  });
});

function fakeBridge() {
  let listener: ((event: BridgeSocketEvent) => void) | null = null;
  let resolveOpen: (id: string) => void = () => {};
  const bridge: CollaBoardBridge = {
    request: vi.fn(async () => ({ status: 200, body: { ok: true } })),
    socketOpen: vi.fn(() => new Promise<string>((resolve) => (resolveOpen = resolve))),
    socketSend: vi.fn(),
    socketClose: vi.fn(),
    onSocketEvent: vi.fn((fn) => {
      listener = fn;
      return () => (listener = null);
    }),
    auth: { login: vi.fn(), register: vi.fn(), logout: vi.fn(), currentUser: vi.fn() },
  };
  return {
    bridge,
    emit: (event: BridgeSocketEvent) => listener?.(event),
    resolveOpen: (id: string) => resolveOpen(id),
    hasListener: () => listener !== null,
  };
}

describe("transporte Electron (IPC)", () => {
  it("delega HTTP al proceso principal y valida la ruta", async () => {
    const { bridge } = fakeBridge();
    const transport = createElectronTransport(bridge);
    expect(await transport.request({ method: "GET", path: "/api/boards" })).toEqual({ status: 200, body: { ok: true } });
    expect(bridge.request).toHaveBeenCalledWith({ method: "GET", path: "/api/boards", body: undefined });
    await expect(transport.request({ method: "GET", path: "/internal/x" })).rejects.toThrow();
  });

  it("expone un socket con la misma semántica que WebSocket", async () => {
    const { bridge, emit, resolveOpen, hasListener } = fakeBridge();
    const socket = createElectronTransport(bridge).openSocket("/ws/boards/b1");
    const onopen = vi.fn();
    const onmessage = vi.fn();
    const onclose = vi.fn();
    Object.assign(socket, { onopen, onmessage, onclose });

    resolveOpen("s1");
    await Promise.resolve();
    emit({ id: "otro", type: "open" }); // eventos de otros sockets se ignoran
    expect(onopen).not.toHaveBeenCalled();
    emit({ id: "s1", type: "open" });
    expect(socket.readyState).toBe(SOCKET_OPEN);

    socket.send('{"type":"ping"}');
    expect(bridge.socketSend).toHaveBeenCalledWith("s1", '{"type":"ping"}');
    emit({ id: "s1", type: "message", data: '{"type":"pong"}' });
    expect(onmessage).toHaveBeenCalledWith({ data: '{"type":"pong"}' });

    emit({ id: "s1", type: "close", code: 4403 });
    expect(onclose).toHaveBeenCalledWith({ code: 4403 });
    expect(socket.readyState).toBe(SOCKET_CLOSED);
    expect(hasListener()).toBe(false);
  });

  it("si se cierra antes de terminar de abrir, cierra al obtener el id", async () => {
    const { bridge, resolveOpen } = fakeBridge();
    const socket = createElectronTransport(bridge).openSocket("/ws/chat/boards/b1");
    socket.close(1000, "bye");
    resolveOpen("s9");
    await Promise.resolve();
    expect(bridge.socketClose).toHaveBeenCalledWith("s9", 1000, "bye");
  });
});
