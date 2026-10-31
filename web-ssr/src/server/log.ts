import "server-only";

/**
 * Registro estructurado (una línea JSON por evento) para correlacionar con el
 * gateway y las APIs mediante `request_id`. Nunca se registran tokens, cookies
 * ni cuerpos de petición.
 */
type Level = "info" | "warn" | "error";

export function log(level: Level, msg: string, fields: Record<string, unknown> = {}): void {
  if (process.env.NODE_ENV === "test" && !process.env.WEB_LOG_IN_TESTS) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, svc: "web-ssr", msg, ...fields });
  if (level === "error") console.error(line);
  else console.log(line);
}
