// Costo de TLS en el gateway (P3 · S1). Un nivel de carga por ejecución; run.sh
// recorre los niveles y las configuraciones.
//
// Variables (todas las fija run.sh):
//   BASE      http://gateway o https://gateway (el generador está en la red edge)
//   ENDPOINT  healthz | dashboard
//   RATE      healthz: llegadas por segundo (tasa fija, igual en todas las
//             configuraciones: así la CPU del gateway por petición es comparable)
//   VUS       dashboard: usuarios virtuales concurrentes (bucle cerrado, sin pausa)
//   DURATION  duración del nivel (p. ej. 60s)
//   REUSE     "1" = keep-alive (como un navegador) · "0" = conexión nueva por petición
//   TOKEN     JWT de la cuenta sembrada (solo para dashboard), obtenido antes de medir
// HTTP/2: k6 lo negocia por ALPN con HTTPS; run.sh lo apaga con GODEBUG=http2client=0
// para comparar HTTP/1.1 contra HTTP/1.1.
import http from "k6/http";
import { check } from "k6";

const ENDPOINTS = {
  // Solo el gateway: aísla el costo del canal (Nginx responde sin upstream).
  healthz: { path: "/healthz", headers: {} },
  // Página SSR real: gateway -> web-ssr -> auth-api + collaboration-api.
  dashboard: { path: "/", headers: { Cookie: `cb_session=${__ENV.TOKEN}` } },
};
const target = ENDPOINTS[__ENV.ENDPOINT || "healthz"];

const load = __ENV.RATE
  ? {
      scenarios: {
        tasa_fija: {
          executor: "constant-arrival-rate",
          rate: Number(__ENV.RATE),
          timeUnit: "1s",
          duration: __ENV.DURATION || "60s",
          preAllocatedVUs: 50,
          maxVUs: 400,
        },
      },
    }
  : { vus: Number(__ENV.VUS || 10), duration: __ENV.DURATION || "60s" };

export const options = {
  ...load,
  noConnectionReuse: __ENV.REUSE === "0",
  summaryTrendStats: ["avg", "min", "med", "p(90)", "p(95)", "p(99)", "max"],
  // Umbrales declarados antes de medir (ver README, sección 7).
  thresholds: {
    http_req_failed: ["rate<0.01"],
    http_req_duration: [__ENV.ENDPOINT === "dashboard" ? "p(95)<1000" : "p(95)<200"],
  },
};

export default function () {
  const res = http.get(`${__ENV.BASE}${target.path}`, { headers: target.headers, redirects: 0 });
  check(res, { "status 200": (r) => r.status === 200 });
}
