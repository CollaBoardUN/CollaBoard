/**
 * Adaptador de transporte del navegador (web SSR).
 *
 * - HTTP: el navegador llama a `/bff/<ruta pública>` en el mismo origen. El BFF
 *   de Next.js lee la cookie HttpOnly y reenvía al gateway con `Authorization:
 *   Bearer`. El JavaScript del navegador nunca ve el JWT.
 * - WebSocket: se abre contra el gateway en el mismo origen; el navegador
 *   adjunta la cookie de sesión automáticamente.
 */
import { sanitizePublicPath, withQuery } from "./paths";
import type { HttpRequest, HttpResponse, SocketLike, Transport } from "./types";

export interface WebTransportOptions {
  /** Prefijo del BFF en este mismo origen. */
  bffBase?: string;
  /** Base `ws(s)://host` para los WebSocket. Vacío = mismo origen que la página. */
  wsBase?: string;
  fetchImpl?: typeof fetch;
  socketFactory?: (url: string) => SocketLike;
}

/** Cabecera que identifica las llamadas del cliente web ante el BFF (defensa CSRF adicional). */
export const WEB_CLIENT_HEADER = "x-collaboard-client";
export const WEB_CLIENT_VALUE = "web";

export function sameOriginWsBase(location: Pick<Location, "protocol" | "host">): string {
  return `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}`;
}

async function readBody(response: Response): Promise<unknown> {
  if (response.status === 204) return null;
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { detail: text.slice(0, 300) };
  }
}

export function createWebTransport(options: WebTransportOptions = {}): Transport {
  const bffBase = (options.bffBase ?? "/bff").replace(/\/$/, "");
  const doFetch = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const socketFactory = options.socketFactory ?? ((url: string) => new WebSocket(url) as SocketLike);

  return {
    kind: "web",

    async request({ method, path, body, signal }: HttpRequest): Promise<HttpResponse> {
      const safe = sanitizePublicPath(path, "api");
      if (!safe) throw new Error(`Ruta no permitida para el cliente: ${path}`);
      const headers: Record<string, string> = {
        Accept: "application/json",
        [WEB_CLIENT_HEADER]: WEB_CLIENT_VALUE,
      };
      if (body !== undefined) headers["Content-Type"] = "application/json";
      try {
        const response = await doFetch(`${bffBase}${withQuery(safe, path)}`, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          credentials: "same-origin",
          cache: "no-store",
          signal,
        });
        return { status: response.status, body: await readBody(response) };
      } catch {
        return { status: 0, body: null };
      }
    },

    openSocket(path: string): SocketLike {
      const safe = sanitizePublicPath(path, "ws");
      if (!safe) throw new Error(`Ruta WebSocket no permitida: ${path}`);
      const base = options.wsBase || sameOriginWsBase(window.location);
      return socketFactory(`${base.replace(/\/$/, "")}${safe}`);
    },
  };
}
