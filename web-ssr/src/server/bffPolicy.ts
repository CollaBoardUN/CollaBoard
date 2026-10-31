/**
 * Reglas del BFF (Backend for Frontend) del navegador, como funciones puras.
 *
 * El navegador llama a `/bff/<ruta pública del gateway>`; antes de reenviar:
 *   1. La ruta debe estar en la lista blanca del contrato (nunca `/internal/*`).
 *   2. Los métodos que modifican datos exigen `Origin` igual al propio sitio
 *      (o a uno explícitamente permitido) y la cabecera del cliente web: así una
 *      página de otro sitio no puede actuar con la cookie del usuario (CSRF).
 */
import { sanitizePublicPath, withQuery } from "@/core/transport/paths";
import { WEB_CLIENT_HEADER, WEB_CLIENT_VALUE } from "@/core/transport/webTransport";

export const BFF_PREFIX = "/bff";
export const BFF_METHODS = ["GET", "POST", "PATCH", "PUT", "DELETE"] as const;
export const BFF_MAX_BODY_BYTES = 256 * 1024;

const SAFE_METHODS = new Set(["GET", "HEAD"]);

export interface BffInput {
  method: string;
  /** Ruta completa recibida, p. ej. `/bff/api/boards?x=1`. */
  url: string;
  origin: string | null;
  /** Origen público de este sitio, calculado con `x-forwarded-*` o `host`. */
  selfOrigin: string;
  allowedOrigins: readonly string[];
  clientHeader: string | null;
}

export type BffDecision = { ok: true; path: string } | { ok: false; status: number; detail: string };

export function decideBff(input: BffInput): BffDecision {
  const method = input.method.toUpperCase();
  if (!(BFF_METHODS as readonly string[]).includes(method)) {
    return { ok: false, status: 405, detail: "Método no permitido" };
  }

  if (!input.url.startsWith(`${BFF_PREFIX}/`)) return { ok: false, status: 404, detail: "Ruta no encontrada" };
  const publicPath = input.url.slice(BFF_PREFIX.length);
  const safe = sanitizePublicPath(publicPath, "api");
  if (!safe) return { ok: false, status: 404, detail: "Ruta no permitida" };

  if (!SAFE_METHODS.has(method)) {
    const allowed = [input.selfOrigin, ...input.allowedOrigins];
    if (!input.origin || !allowed.includes(input.origin)) {
      return { ok: false, status: 403, detail: "Origen no permitido" };
    }
    if (input.clientHeader !== WEB_CLIENT_VALUE) {
      return { ok: false, status: 403, detail: `Falta la cabecera ${WEB_CLIENT_HEADER}` };
    }
  }
  return { ok: true, path: withQuery(safe, publicPath) };
}

/** Origen público de la petición, respetando el proxy (gateway) que la reenvía. */
export function publicOrigin(headers: Headers, fallbackUrl: string): string {
  const forwardedHost = headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const host = forwardedHost || headers.get("host");
  const forwardedProto = headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  if (!host) return new URL(fallbackUrl).origin;
  const proto = forwardedProto || new URL(fallbackUrl).protocol.replace(":", "");
  return `${proto}://${host}`;
}
