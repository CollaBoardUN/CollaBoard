import "server-only";

/**
 * Configuración del servidor web, leída del entorno en tiempo de ejecución (no
 * al compilar): la misma imagen Docker sirve en cualquier despliegue.
 */

function readBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return raw.toLowerCase() === "true";
}

function readInt(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

export const serverConfig = {
  /**
   * URL interna del API Gateway (red de Docker). El servidor SSR y el BFF solo
   * llaman a rutas `/api/*`, nunca a páginas: así no hay bucles gateway <-> web.
   */
  get gatewayUrl(): string {
    return trimSlash(process.env.GATEWAY_INTERNAL_URL || "http://localhost:8088");
  },
  /** Tiempo máximo de cada llamada al gateway. */
  get requestTimeoutMs(): number {
    return readInt("GATEWAY_TIMEOUT_MS", 8000);
  },
  /** `true` en producción con HTTPS. En local (http://localhost) debe ser `false`. */
  get cookieSecure(): boolean {
    return readBool("SESSION_COOKIE_SECURE", false);
  },
  /** Base pública `ws(s)://host` para los WebSocket del navegador. Vacío = mismo origen. */
  get publicWsUrl(): string {
    return trimSlash(process.env.PUBLIC_WS_URL || "");
  },
  /** Enlace al lienzo de Pixels en la barra superior. Vacío = se oculta. */
  get pixelsUrl(): string | null {
    const url = process.env.PUBLIC_PIXELS_URL?.trim();
    return url ? url : null;
  },
  /** Orígenes adicionales aceptados por el BFF (además del propio), separados por coma. */
  get extraAllowedOrigins(): string[] {
    return (process.env.BFF_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((origin) => trimSlash(origin.trim()))
      .filter(Boolean);
  },
};

export const SESSION_COOKIE = "cb_session";
