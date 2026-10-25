/**
 * Rutas públicas del gateway que pueden usar los clientes (plan P2, sección 4).
 * Lo comparten el BFF de la web y el proceso principal de Electron para que
 * ninguno reenvíe rutas internas (`/internal/*`) ni rutas fuera del contrato.
 */

/** Prefijos REST que la interfaz consume con la sesión del usuario. */
export const CLIENT_API_PREFIXES = [
  "/api/boards",
  "/api/invites",
  "/api/canvas",
  "/api/chat",
  "/api/notifications",
  "/api/pixels",
] as const;

/** Prefijos WebSocket expuestos por el gateway. */
export const CLIENT_WS_PREFIXES = ["/ws/boards/", "/ws/chat/boards/", "/ws/pixels"] as const;

const SAFE_SEGMENT = /^[A-Za-z0-9._~\-:@]+$/;

function hasPrefix(path: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => path === prefix || path.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`));
}

/**
 * Valida una ruta pública. Devuelve la ruta (sin query) si es segura, o `null`.
 * Rechaza `..`, segmentos vacíos o codificados raros y cualquier `internal`.
 */
export function sanitizePublicPath(path: string, kind: "api" | "ws"): string | null {
  if (typeof path !== "string" || !path.startsWith("/")) return null;
  const [pathname] = path.split("?", 1);
  const segments = pathname.split("/").slice(1);
  if (segments.length === 0) return null;
  for (const segment of segments) {
    if (!segment || segment === "." || segment === ".." || !SAFE_SEGMENT.test(segment)) return null;
    if (segment.toLowerCase() === "internal") return null;
  }
  const prefixes = kind === "api" ? CLIENT_API_PREFIXES : CLIENT_WS_PREFIXES;
  return hasPrefix(pathname, prefixes) ? pathname : null;
}

/** Une la ruta validada con su query string original (si la había). */
export function withQuery(pathname: string, original: string): string {
  const index = original.indexOf("?");
  return index === -1 ? pathname : `${pathname}${original.slice(index)}`;
}
