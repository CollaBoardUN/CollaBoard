/**
 * Sesión vencida o revocada: borra la cookie (solo se puede en un Route Handler
 * o Server Action) y lleva al login conservando a dónde quería ir la persona.
 */
import { NextResponse, type NextRequest } from "next/server";

import { safeNext } from "@/core/lib/safeNext";
import { SESSION_COOKIE, serverConfig } from "@/server/config";

export const dynamic = "force-dynamic";

export function GET(request: NextRequest) {
  const next = safeNext(request.nextUrl.searchParams.get("next"));
  const target = new URL("/login", request.url);
  target.searchParams.set("next", next);
  target.searchParams.set("reason", "expired");
  // Ruta relativa: detrás del gateway el host interno no coincide con el público.
  const response = new NextResponse(null, {
    status: 303,
    headers: { Location: target.pathname + target.search, "Cache-Control": "no-store" },
  });
  response.cookies.set({
    name: SESSION_COOKIE,
    value: "",
    httpOnly: true,
    sameSite: "lax",
    secure: serverConfig.cookieSecure,
    path: "/",
    maxAge: 0,
  });
  return response;
}
