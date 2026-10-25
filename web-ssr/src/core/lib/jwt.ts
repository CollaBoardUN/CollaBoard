/**
 * Lectura del contenido de un JWT SIN verificar la firma.
 *
 * Solo sirve para decisiones locales sin riesgo (¿ya venció?, ¿cuánto dura la
 * cookie?). La verificación real la hace Auth (`GET /auth/me`) y cada API.
 */

export interface TokenClaims {
  sub: string;
  name?: string;
  email?: string;
  /** Segundos desde la época Unix. */
  exp?: number;
}

function decodeSegment(segment: string): string {
  const base64 = segment.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function readClaims(token: string): TokenClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(decodeSegment(parts[1])) as Record<string, unknown>;
    if (typeof payload.sub !== "string" || !payload.sub) return null;
    return {
      sub: payload.sub,
      name: typeof payload.name === "string" ? payload.name : undefined,
      email: typeof payload.email === "string" ? payload.email : undefined,
      exp: typeof payload.exp === "number" ? payload.exp : undefined,
    };
  } catch {
    return null;
  }
}

/** Segundos de vida que le quedan al token (0 si venció o no se puede leer). */
export function secondsUntilExpiry(token: string, now = Date.now()): number {
  const claims = readClaims(token);
  if (!claims?.exp) return 0;
  return Math.max(0, Math.floor(claims.exp - now / 1000));
}
