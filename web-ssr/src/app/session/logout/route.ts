/** Logout de servidor mediante refresh token guardado con Path=/session. */
import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { REFRESH_COOKIE, SESSION_COOKIE, serverConfig } from "@/server/config";
import { gatewayJson } from "@/server/gateway";

export const dynamic = "force-dynamic";

async function doLogout() {
  const refresh = (await cookies()).get(REFRESH_COOKIE)?.value;
  if (refresh) {
    // Si el backend falla no decimos que se revocó, ni borramos el token para poder reintentar.
    await gatewayJson<void>("/api/auth/logout", { method: "POST", body: { refresh_token: refresh } });
  }
  const response = new NextResponse(null, { status: 303,
    headers: { Location: "/login", "Cache-Control": "no-store" } });
  response.cookies.set({ name: SESSION_COOKIE, value: "", path: "/", maxAge: 0,
    httpOnly: true, sameSite: "lax", secure: serverConfig.cookieSecure });
  response.cookies.set({ name: REFRESH_COOKIE, value: "", path: "/session", maxAge: 0,
    httpOnly: true, sameSite: "strict", secure: serverConfig.cookieSecure });
  return response;
}
export async function POST(request: NextRequest) {
  const origin = request.headers.get("origin");
  if (origin && origin !== request.nextUrl.origin) {
    return NextResponse.json({ detail: "Origen no permitido" }, { status: 403 });
  }
  try { return await doLogout(); }
  catch { return NextResponse.json({detail: "No se pudo revocar la sesión. Intenta de nuevo."}, { status: 503 }); }
}
// Compatibilidad con los enlaces/redirecciones de cierre de sesión existentes.
export async function GET() {
  try { return await doLogout(); }
  catch { return NextResponse.json({detail: "No se pudo revocar la sesión."}, { status: 503 }); }
}
