/**
 * BFF del navegador: `/bff/<ruta pública>` -> gateway `/<ruta pública>`.
 *
 * Lee la cookie HttpOnly y reenvía con `Authorization: Bearer`, de modo que el
 * JavaScript del navegador nunca maneja el JWT y las APIs siguen recibiendo el
 * mismo Bearer que el cliente de escritorio. Ver `server/bffPolicy.ts`.
 */
import { NextResponse, type NextRequest } from "next/server";

import { readClaims, secondsUntilExpiry } from "@/core/lib/jwt";
import { WEB_CLIENT_HEADER } from "@/core/transport/webTransport";
import { BFF_MAX_BODY_BYTES, decideBff, publicOrigin } from "@/server/bffPolicy";
import { SESSION_COOKIE, serverConfig } from "@/server/config";
import { callGateway, GatewayError } from "@/server/gateway";
import { pickRequestId } from "@/server/requestIdPolicy";

export const dynamic = "force-dynamic";

function reply(status: number, body: unknown, requestId: string): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store", "X-Request-Id": requestId },
  });
}

async function handle(request: NextRequest): Promise<Response> {
  const requestId = pickRequestId(request.headers.get("x-request-id"));
  const decision = decideBff({
    method: request.method,
    url: request.nextUrl.pathname + request.nextUrl.search,
    origin: request.headers.get("origin"),
    selfOrigin: publicOrigin(request.headers, request.url),
    allowedOrigins: serverConfig.extraAllowedOrigins,
    clientHeader: request.headers.get(WEB_CLIENT_HEADER),
  });
  if (!decision.ok) return reply(decision.status, { detail: decision.detail }, requestId);

  const token = request.cookies.get(SESSION_COOKIE)?.value ?? null;
  if (!token || !readClaims(token) || secondsUntilExpiry(token) <= 0) {
    return reply(401, { detail: "Tu sesión expiró. Vuelve a iniciar sesión" }, requestId);
  }

  let rawBody: string | null = null;
  if (request.method !== "GET" && request.method !== "DELETE") {
    const declared = Number(request.headers.get("content-length") ?? "0");
    if (declared > BFF_MAX_BODY_BYTES) return reply(413, { detail: "El contenido es demasiado grande" }, requestId);
    rawBody = await request.text();
    if (new TextEncoder().encode(rawBody).byteLength > BFF_MAX_BODY_BYTES) {
      return reply(413, { detail: "El contenido es demasiado grande" }, requestId);
    }
    if (rawBody && !request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
      return reply(415, { detail: "Envía el contenido como application/json" }, requestId);
    }
  }

  let upstream: Response;
  try {
    upstream = await callGateway(decision.path, {
      method: request.method,
      token,
      rawBody: rawBody || null,
      contentType: rawBody ? "application/json" : null,
      requestId,
      signal: request.signal,
    });
  } catch (error) {
    const status = error instanceof GatewayError ? error.status : 502;
    return reply(status, { detail: "El servicio no está disponible en este momento" }, requestId);
  }

  // Solo se devuelve estado, tipo y cuerpo: nunca cabeceras como Set-Cookie del servicio.
  const headers = new Headers({ "Cache-Control": "no-store", "X-Request-Id": requestId });
  const contentType = upstream.headers.get("content-type");
  if (contentType) headers.set("Content-Type", contentType);
  const body = upstream.status === 204 || upstream.status === 304 ? null : await upstream.arrayBuffer();
  return new Response(body, { status: upstream.status, headers });
}

export { handle as DELETE, handle as GET, handle as PATCH, handle as POST, handle as PUT };
