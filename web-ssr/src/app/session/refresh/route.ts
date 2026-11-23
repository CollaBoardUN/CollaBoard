/** Renovación de sesión en Route Handler: cb_refresh nunca llega al navegador JavaScript. */
import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { safeNext } from "@/core/lib/safeNext";
import { secondsUntilExpiry } from "@/core/lib/jwt";
import { isAllowedFormOrigin, publicOrigin } from "@/server/bffPolicy";
import { REFRESH_COOKIE, SESSION_COOKIE, serverConfig } from "@/server/config";
import { gatewayJson } from "@/server/gateway";

export const dynamic = "force-dynamic";

type AuthSession = { access_token: string; refresh_token: string };

function redirectRelative(path: string) {
  return new NextResponse(null, { status: 303, headers: { Location: path, "Cache-Control": "no-store" } });
}
/**
 * Sin renovación posible se va al login conservando `next` (p. ej. un link de
 * invitación /join/{token}). «Sesión expirada» solo se muestra si de verdad había
 * una sesión: a un visitante nuevo no se le dice que su sesión venció.
 */
function toLogin(next: string, hadSession: boolean) {
  const params = new URLSearchParams();
  if (next !== "/") params.set("next", next);
  if (hadSession) params.set("reason", "expired");
  const query = params.toString();
  const response = redirectRelative(query ? `/login?${query}` : "/login");
  clearAll(response);
  return response;
}
function clearAll(response: NextResponse) {
  response.cookies.set({ name: SESSION_COOKIE, value: "", path: "/", maxAge: 0,
    httpOnly: true, sameSite: "lax", secure: serverConfig.cookieSecure });
  response.cookies.set({ name: REFRESH_COOKIE, value: "", path: "/session", maxAge: 0,
    httpOnly: true, sameSite: "strict", secure: serverConfig.cookieSecure });
}
function setTokens(response: NextResponse, session: AuthSession) {
  const age = secondsUntilExpiry(session.access_token);
  if (age <= 0 || !session.refresh_token) throw new Error("Tokens de renovación inválidos");
  response.cookies.set({ name: SESSION_COOKIE, value: session.access_token, path: "/",
    maxAge: age, httpOnly: true, sameSite: "lax", secure: serverConfig.cookieSecure });
  response.cookies.set({ name: REFRESH_COOKIE, value: session.refresh_token, path: "/session",
    maxAge: 7*24*3600, httpOnly: true, sameSite: "strict", secure: serverConfig.cookieSecure });
}
async function renew() {
  const token = (await cookies()).get(REFRESH_COOKIE)?.value;
  if (!token) return null;
  try {
    return await gatewayJson<AuthSession>("/api/auth/refresh", {
      method: "POST", body: { refresh_token: token },
    });
  } catch { return null; }
}
export async function GET(request: NextRequest) {
  const next = safeNext(request.nextUrl.searchParams.get("next"));
  const hadSession = request.cookies.has(SESSION_COOKIE) || request.cookies.has(REFRESH_COOKIE);
  const session = await renew();
  if (!session) return toLogin(next, hadSession);
  const response = redirectRelative(next);
  setTokens(response, session);
  return response;
}
export async function POST(request: NextRequest) {
  const self = publicOrigin(request.headers, request.url);
  if (!isAllowedFormOrigin(request.headers.get("origin"), self, serverConfig.extraAllowedOrigins)) {
    return NextResponse.json({ detail: "Origen no permitido" }, { status: 403 });
  }
  const session = await renew();
  if (!session) {
    const response = NextResponse.json({ detail: "Sesión expirada" }, { status: 401 });
    clearAll(response);
    return response;
  }
  const response = NextResponse.json({ renewed: true }, { headers: { "Cache-Control": "no-store" } });
  setTokens(response, session);
  return response;
}
