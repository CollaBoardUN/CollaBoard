/**
 * Cliente HTTP del backend. Añade el token automáticamente y convierte los
 * errores de FastAPI en un ApiError con un mensaje legible.
 *
 * Las otras personas pueden reutilizarlo:  api.get<Element[]>(`/boards/${id}/elements`)
 */
import { useAuth } from "../auth/authStore";

export const API_URL = (import.meta.env.VITE_API_URL ?? "http://localhost:8000").replace(
  /\/$/,
  "",
);

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

function messageFrom(status: number, body: unknown): string {
  if (body && typeof body === "object" && "detail" in body) {
    const detail = (body as { detail: unknown }).detail;
    if (typeof detail === "string") return detail;
    // Errores de validación (422): lista de {loc, msg}
    if (Array.isArray(detail) && detail[0]?.msg) return String(detail[0].msg);
  }
  if (status === 0) return "No se pudo conectar con el servidor";
  return `Error ${status}`;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const token = useAuth.getState().token;
  if (token) headers.Authorization = `Bearer ${token}`;

  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, messageFrom(0, null));
  }

  if (res.status === 204) return undefined as T;

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    // Token vencido o inválido: cerramos sesión para volver al login.
    if (res.status === 401 && token) useAuth.getState().logout();
    throw new ApiError(res.status, messageFrom(res.status, data));
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body),
  patch: <T>(path: string, body?: unknown) => request<T>("PATCH", path, body),
  delete: (path: string) => request<void>("DELETE", path),
};
