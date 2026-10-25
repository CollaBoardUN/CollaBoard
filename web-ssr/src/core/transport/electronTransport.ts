/**
 * Adaptador de transporte para el cliente local Electron (lo integra Sebastian).
 *
 * El renderer no tiene APIs de Node ni ve el token: el `preload` expone con
 * `contextBridge` un objeto `CollaBoardBridge` y el proceso principal hace las
 * llamadas HTTP (Bearer) y abre los WebSocket (credencial en cabecera) contra el
 * gateway configurado. Ver docs/p2/ADAPTADOR_ELECTRON.md.
 */
import type { SessionUser } from "../domain/types";
import { sanitizePublicPath } from "./paths";
import {
  SOCKET_CLOSED,
  SOCKET_CONNECTING,
  SOCKET_OPEN,
  type HttpRequest,
  type HttpResponse,
  type SocketLike,
  type Transport,
} from "./types";

export interface BridgeHttpRequest {
  method: HttpRequest["method"];
  path: string;
  body?: unknown;
}

export type BridgeSocketEvent =
  | { id: string; type: "open" }
  | { id: string; type: "message"; data: string }
  | { id: string; type: "error" }
  | { id: string; type: "close"; code: number };

export interface BridgeCredentials {
  email: string;
  password: string;
}

export interface BridgeRegistration extends BridgeCredentials {
  name: string;
  confirm_password: string;
}

/** API que el `preload` de Electron publica como `window.collaboard`. */
export interface CollaBoardBridge {
  request(request: BridgeHttpRequest): Promise<HttpResponse>;
  socketOpen(path: string): Promise<string>;
  socketSend(id: string, data: string): void;
  socketClose(id: string, code?: number, reason?: string): void;
  /** Devuelve la función para dejar de escuchar. */
  onSocketEvent(listener: (event: BridgeSocketEvent) => void): () => void;
  auth: {
    login(credentials: BridgeCredentials): Promise<SessionUser>;
    register(data: BridgeRegistration): Promise<SessionUser>;
    logout(): Promise<void>;
    currentUser(): Promise<SessionUser | null>;
  };
}

/** WebSocket "virtual": el real vive en el proceso principal. */
class BridgeSocket implements SocketLike {
  readyState = SOCKET_CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  private id: string | null = null;
  private closeRequested: { code?: number; reason?: string } | null = null;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly bridge: CollaBoardBridge,
    path: string,
  ) {
    this.unsubscribe = bridge.onSocketEvent((event) => this.handle(event));
    bridge.socketOpen(path).then(
      (id) => {
        this.id = id;
        if (this.closeRequested) bridge.socketClose(id, this.closeRequested.code, this.closeRequested.reason);
      },
      () => this.finish(1006),
    );
  }

  send(data: string): void {
    if (this.readyState === SOCKET_OPEN && this.id) this.bridge.socketSend(this.id, data);
  }

  close(code?: number, reason?: string): void {
    if (this.readyState === SOCKET_CLOSED) return;
    if (this.id) this.bridge.socketClose(this.id, code, reason);
    else this.closeRequested = { code, reason };
  }

  private handle(event: BridgeSocketEvent): void {
    if (!this.id || event.id !== this.id) return;
    switch (event.type) {
      case "open":
        this.readyState = SOCKET_OPEN;
        this.onopen?.();
        break;
      case "message":
        this.onmessage?.({ data: event.data });
        break;
      case "error":
        this.onerror?.();
        break;
      case "close":
        this.finish(event.code);
        break;
    }
  }

  private finish(code: number): void {
    if (this.readyState === SOCKET_CLOSED) return;
    this.readyState = SOCKET_CLOSED;
    this.unsubscribe();
    this.onclose?.({ code });
  }
}

export function createElectronTransport(bridge: CollaBoardBridge): Transport {
  return {
    kind: "electron",

    async request({ method, path, body }: HttpRequest): Promise<HttpResponse> {
      if (!sanitizePublicPath(path, "api")) throw new Error(`Ruta no permitida para el cliente: ${path}`);
      try {
        return await bridge.request({ method, path, body });
      } catch {
        return { status: 0, body: null };
      }
    },

    openSocket(path: string): SocketLike {
      if (!sanitizePublicPath(path, "ws")) throw new Error(`Ruta WebSocket no permitida: ${path}`);
      return new BridgeSocket(bridge, path);
    },
  };
}
