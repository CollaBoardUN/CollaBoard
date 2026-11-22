// Banco k6 para la prueba de rendimiento S5 · Authorizer RBAC y caché Cache-Aside en los PEPs.
//
// Variables de entorno:
//   BASE       : URL del gateway (por defecto http://gateway)
//   ENDPOINT   : "canvas" (GET /api/boards/{id}/state) | "chat" (POST /api/chat/boards/{id}/messages) | "mixed"
//   TOKEN      : JWT Bearer del usuario editor sembrado antes de medir
//   BOARD_ID   : UUID del tablero sembrado
//   VUS        : número de usuarios virtuales concurrentes (ej. 10, 25, 50)
//   DURATION   : duración del nivel (ej. 60s)
import http from 'k6/http';
import { check } from 'k6';
import { Rate, Trend } from 'k6/metrics';

const base = __ENV.BASE || 'http://gateway';
const endpoint = __ENV.ENDPOINT || 'mixed';
const token = __ENV.TOKEN || '';
const boardId = __ENV.BOARD_ID || '';
const vus = parseInt(__ENV.VUS || '25', 10);
const duration = __ENV.DURATION || '60s';

const canvasLatency = new Trend('rbac_canvas_read_ms', true);
const chatLatency = new Trend('rbac_chat_post_ms', true);
const authzErrorRate = new Rate('rbac_error_rate');

export const options = {
  scenarios: {
    rbac_load: {
      executor: 'constant-vus',
      vus: vus,
      duration: duration,
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<250', 'p(99)<500'],
    rbac_error_rate: ['rate<0.01'],
  },
};

const headers = {
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
};

export default function () {
  const doCanvas = endpoint === 'canvas' || (endpoint === 'mixed' && (__ITER % 5 !== 0));

  if (doCanvas) {
    const res = http.get(`${base}/api/boards/${boardId}/state`, {
      headers,
      tags: { op: 'canvas_read_state' },
    });
    canvasLatency.add(res.timings.duration);
    const ok = check(res, {
      'canvas state 200': (r) => r.status === 200,
    });
    authzErrorRate.add(!ok);
  } else {
    const payload = JSON.stringify({
      text: `perf-rbac-vu${__VU}-it${__ITER}`,
      client_msg_id: `rbac-${__VU}-${__ITER}-${Date.now()}`,
    });
    const res = http.post(`${base}/api/chat/boards/${boardId}/messages`, payload, {
      headers,
      tags: { op: 'chat_send_message' },
    });
    chatLatency.add(res.timings.duration);
    const ok = check(res, {
      'chat message 201': (r) => r.status === 201,
    });
    authzErrorRate.add(!ok);
  }
}
