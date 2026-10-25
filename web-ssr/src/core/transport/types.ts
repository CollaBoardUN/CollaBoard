/**
 * Contrato de transporte compartido por la web y el cliente local.
 *
 * Los componentes y las APIs tipadas (core/api) solo conocen esta interfaz; cada
 * presentación aporta su adaptador:
 *   - Web SSR:  HTTP a /bff/* (cookie HttpOnly) y WebSocket al mismo origen.
 *   - Electron: HTTP y WebSocket desde el proceso principal, vía IPC acotado.
 * Así la credencial nunca llega al código de interfaz.
 */

export type HttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export interface HttpRequest {
  method: HttpMethod;
  /** Ruta pública del gateway, p. ej. `/api/boards`. */
  path: string;
  body?: unknown;
  signal?: AbortSignal;
}

export interface HttpResponse {
  /** 0 = no hubo respuesta (sin red, servidor caído, petición cancelada). */
  status: number;
  body: unknown;
}

/** Estados de `readyState`, iguales a los de `WebSocket`. */
export const SOCKET_CONNECTING = 0;
export const SOCKET_OPEN = 1;
export const SOCKET_CLOSING = 2;
export const SOCKET_CLOSED = 3;

/**
 * Lo mínimo de `WebSocket` que usan los clientes de tiempo real. El WebSocket
 * del navegador lo cumple tal cual; Electron lo implementa sobre IPC.
 */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: (() => void) | null;
  onclose: ((event: { code: number }) => void) | null;
}

export interface Transport {
  readonly kind: "web" | "electron";
  /** Nunca lanza por códigos HTTP: devuelve el estado y el cuerpo ya parseado. */
  request(request: HttpRequest): Promise<HttpResponse>;
  /** `path` es la ruta pública WS del gateway, p. ej. `/ws/boards/{id}`. */
  openSocket(path: string): SocketLike;
}
