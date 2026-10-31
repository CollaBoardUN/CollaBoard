import "server-only";

/**
 * Cliente HTTP del servidor web hacia el API Gateway (conector C02 del C&C).
 *
 * - Siempre `cache: "no-store"`: son datos privados de cada usuario; nunca se
 *   guardan en una caché compartida.
 * - Propaga `X-Request-Id` para seguir una petición entre gateway, web y APIs.
 * - Tiempo límite por llamada: una API lenta no bloquea el render indefinidamente.
 */
import { errorMessage } from "@/core/transport/apiClient";
import { serverConfig } from "./config";
import { log } from "./log";

export class GatewayError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "GatewayError";
    this.status = status;
  }
}

export interface GatewayRequest {
  method?: string;
  token?: string | null;
  body?: unknown;
  /** Cuerpo ya serializado (BFF: se reenvía tal cual). */
  rawBody?: BodyInit | null;
  contentType?: string | null;
  requestId?: string;
  signal?: AbortSignal;
}

function buildSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(serverConfig.requestTimeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** Llama al gateway y devuelve la respuesta tal cual (sin lanzar por códigos HTTP). */
export async function callGateway(path: string, request: GatewayRequest = {}): Promise<Response> {
  const method = request.method ?? "GET";
  const headers = new Headers({ Accept: "application/json" });
  if (request.token) headers.set("Authorization", `Bearer ${request.token}`);
  if (request.requestId) headers.set("X-Request-Id", request.requestId);
  let body: BodyInit | null | undefined = request.rawBody;
  if (request.body !== undefined) {
    body = JSON.stringify(request.body);
    headers.set("Content-Type", "application/json");
  } else if (request.contentType) {
    headers.set("Content-Type", request.contentType);
  }

  const started = Date.now();
  try {
    const response = await fetch(`${serverConfig.gatewayUrl}${path}`, {
      method,
      headers,
      body,
      cache: "no-store",
      redirect: "manual",
      signal: buildSignal(request.signal),
    });
    log(response.status >= 500 ? "warn" : "info", "gateway", {
      request_id: request.requestId,
      method,
      path: path.split("?", 1)[0],
      status: response.status,
      duration_ms: Date.now() - started,
    });
    return response;
  } catch (error) {
    log("error", "gateway_unreachable", {
      request_id: request.requestId,
      method,
      path: path.split("?", 1)[0],
      duration_ms: Date.now() - started,
      error: (error as Error).name,
    });
    throw new GatewayError(503, errorMessage(0, null));
  }
}

/** Igual que `callGateway`, pero devuelve el JSON o lanza `GatewayError` con un mensaje legible. */
export async function gatewayJson<T>(path: string, request: GatewayRequest = {}): Promise<T> {
  const response = await callGateway(path, request);
  const text = await response.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { detail: text.slice(0, 200) };
    }
  }
  if (!response.ok) throw new GatewayError(response.status, errorMessage(response.status, data));
  return data as T;
}
