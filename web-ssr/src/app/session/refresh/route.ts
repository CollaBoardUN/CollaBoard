/** Renovación de sesión en Route Handler: cb_refresh nunca llega al navegador JavaScript. */
import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { safeNext } from "@/core/lib/safeNext";
import { secondsUntilExpiry } from "@/core/lib/jwt";
import { REFRESH_COOKIE, SESSION_COOKIE, serverConfig } from "@/server/config";
import { gatewayJson } from "@/server/gateway";

export const dynamic = "force-dynamic";

type AuthSession = { access_token: string; refresh_token: string };

function redirectRelative(path: string) {
  return new NextResponse(null, { status: 303, headers: { Location: path, "Cache-Control": "no-store" } });
}
function expired() {
  const response = redirectRelative("/login?reason=expired");
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
  const session = await renew();
  if (!session) return expired();
  const response = redirectRelative(next);
  setTokens(response, session);
  return response;
}
export async function POST(request: NextRequest) {
  const origin = request.headers.get("origin");
  if (origin && origin !== request.nextUrl.origin) {
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
