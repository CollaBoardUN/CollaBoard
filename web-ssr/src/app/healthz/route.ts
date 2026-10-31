/** Healthcheck de liveness para Docker/Compose: no depende de otros servicios. */
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json(
    { status: "ok", service: "web-ssr" },
    { headers: { "Cache-Control": "no-store" } },
  );
}
