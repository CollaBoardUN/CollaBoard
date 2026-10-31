/**
 * Cliente HTTP tipado sobre cualquier `Transport`. Convierte los errores de las
 * APIs (FastAPI, Go, Java o C#) en un `ApiError` con un mensaje legible.
 */
import type { HttpMethod, Transport } from "./types";

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/** Mensaje para el usuario a partir del cuerpo de error de cualquier API del sistema. */
export function errorMessage(status: number, body: unknown): string {
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    const detail = record.detail ?? record.message ?? record.error ?? record.title;
    if (typeof detail === "string" && detail.trim()) return detail;
    // Errores de validación de FastAPI (422): lista de {loc, msg}.
    if (Array.isArray(detail) && detail[0] && typeof detail[0].msg === "string") return detail[0].msg;
  }
  if (status === 0) return "No se pudo conectar con el servidor";
  if (status === 401) return "Tu sesión expiró. Vuelve a iniciar sesión";
  if (status === 403) return "No tienes permiso para hacer esto";
  if (status === 404) return "No encontramos lo que buscas";
  if (status === 429) return "Demasiadas solicitudes. Intenta en un momento";
  if (status >= 500) return "El servicio no está disponible en este momento";
  return `Error ${status}`;
}

export interface ApiClientOptions {
  /** Se llama ante un 401 (sesión vencida o inválida). */
  onUnauthorized?: () => void;
}

export interface ApiClient {
  get<T>(path: string, signal?: AbortSignal): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  patch<T>(path: string, body?: unknown): Promise<T>;
  delete(path: string): Promise<void>;
}

export function createApiClient(transport: Transport, options: ApiClientOptions = {}): ApiClient {
  async function send<T>(method: HttpMethod, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const response = await transport.request({ method, path, body, signal });
    if (response.status >= 200 && response.status < 300) return response.body as T;
    if (response.status === 401) options.onUnauthorized?.();
    throw new ApiError(response.status, errorMessage(response.status, response.body));
  }

  return {
    get: (path, signal) => send("GET", path, undefined, signal),
    post: (path, body) => send("POST", path, body),
    patch: (path, body) => send("PATCH", path, body),
    delete: (path) => send<void>("DELETE", path),
  };
}
