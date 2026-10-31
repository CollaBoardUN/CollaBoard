/**
 * Proxy de Next.js (antes "middleware"): verificación OPTIMISTA antes de renderizar.
 *
 * - Sin cookie de sesión vigente, las páginas privadas redirigen al login sin
 *   gastar un render ni llamadas a las APIs.
 * - Con sesión, /login y /register llevan al dashboard.
 * - Asegura un `X-Request-Id` para correlacionar logs del gateway, la web y las APIs.
 *
 * No reemplaza la verificación real: cada página consulta Auth por la DAL y cada
 * API valida el JWT por su cuenta.
 */
import { NextResponse, type NextRequest } from "next/server";

import { readClaims, secondsUntilExpiry } from "@/core/lib/jwt";
import { pickRequestId } from "@/server/requestIdPolicy";

// Mismo nombre que `SESSION_COOKIE` en server/config.ts (el proxy no importa módulos server-only).
const SESSION_COOKIE = "cb_session";
const PUBLIC_PAGES = new Set(["/login", "/register"]);

function hasLiveSession(request: NextRequest): boolean {
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  return !!token && !!readClaims(token) && secondsUntilExpiry(token) > 0;
}

/**
 * El proxy exige URL absoluta. `request.nextUrl` ya usa el host público que
 * envía el gateway (`X-Forwarded-Host`), no el interno del contenedor.
 */
function redirectTo(request: NextRequest, location: string, requestId: string): NextResponse {
  const response = NextResponse.redirect(new URL(location, request.nextUrl.origin), 307);
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("X-Request-Id", requestId);
  return response;
}

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const requestId = pickRequestId(request.headers.get("x-request-id"));
  const loggedIn = hasLiveSession(request);

  if (!PUBLIC_PAGES.has(pathname) && !loggedIn) {
    const query = pathname === "/" ? "" : `?next=${encodeURIComponent(pathname + search)}`;
    return redirectTo(request, `/login${query}`, requestId);
  }
  if (PUBLIC_PAGES.has(pathname) && loggedIn && !request.nextUrl.searchParams.has("reason")) {
    return redirectTo(request, "/", requestId);
  }

  const headers = new Headers(request.headers);
  headers.set("x-request-id", requestId);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set("X-Request-Id", requestId);
  return response;
}

export const config = {
  // Solo páginas: se excluyen el BFF, rutas técnicas y archivos estáticos.
  matcher: ["/((?!bff/|session/|healthz|_next/|favicon\\.svg|collaboard-logo\\.svg|.*\\.[a-z0-9]+$).*)"],
};
