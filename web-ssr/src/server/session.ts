import "server-only";

/**
 * Sesión web en una cookie HttpOnly (plan P2, sección 4: "Sesión SSR").
 *
 * - HttpOnly: el JavaScript del navegador no puede leer el JWT (mitiga XSS).
 * - SameSite=Lax: no viaja en peticiones de otros sitios (CSRF), pero sí al
 *   abrir un link de invitación desde otra aplicación.
 * - Secure en HTTPS (SESSION_COOKIE_SECURE=true).
 * - Vence junto con el token (`exp`), así no quedan cookies huérfanas.
 *
 * La cookie guarda el JWT emitido por Auth (Go) sin cambiarlo: el gateway y las
 * APIs pueden leerlo para autenticar el WebSocket del navegador.
 */
import { cookies } from "next/headers";

import { readClaims, secondsUntilExpiry } from "@/core/lib/jwt";
import { SESSION_COOKIE, serverConfig } from "./config";

/** Token vigente de la cookie, o `null` si no hay o ya venció (sin llamar a nadie). */
export async function readSessionToken(): Promise<string | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token || !readClaims(token)) return null;
  return secondsUntilExpiry(token) > 0 ? token : null;
}

/** Solo en Server Actions o Route Handlers. */
export async function writeSessionCookie(token: string): Promise<void> {
  const maxAge = secondsUntilExpiry(token);
  if (maxAge <= 0) throw new Error("El servidor de autenticación devolvió un token vencido o inválido");
  (await cookies()).set({
    name: SESSION_COOKIE,
    value: token,
    httpOnly: true,
    sameSite: "lax",
    secure: serverConfig.cookieSecure,
    path: "/",
    maxAge,
    priority: "high",
  });
}

/** Solo en Server Actions o Route Handlers. */
export async function clearSessionCookie(): Promise<void> {
  (await cookies()).set({
    name: SESSION_COOKIE,
    value: "",
    httpOnly: true,
    sameSite: "lax",
    secure: serverConfig.cookieSecure,
    path: "/",
    maxAge: 0,
  });
}
