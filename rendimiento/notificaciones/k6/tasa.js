import http from 'k6/http';
import { check } from 'k6';
import { Rate } from 'k6/metrics';

const rate = Number(__ENV.RATE || 10);
const seconds = Number(__ENV.DURATION_S || 60);
const runId = __ENV.RUN_ID || 'saturacion';
const token = __ENV.NOTIFICATIONS_SERVICE_TOKEN;
const base = __ENV.NOTIFICATIONS_API || 'http://notification-api:8080';

export const options = {
  scenarios: {
    saturacion: {
      executor: 'constant-arrival-rate',
      rate,
      timeUnit: '1s',
      duration: `${seconds}s`,
      preAllocatedVUs: 150,
      maxVUs: 200,
      gracefulStop: '10s',
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<500'],
    http_req_failed: ['rate<0.01'],
    dropped_iterations: ['count==0'],
  },
};

const accepted = new Rate('event_accepted');

export default function () {
  const event = {
    event_id: `${runId}-${__VU}-${__ITER}`,
    type: 'chat.message.created',
    occurred_at: new Date().toISOString(),
    actor_id: 'perf-sender',
    board_id: 'perf-board',
    recipient_ids: [`perf-receiver-${__VU}`],
    payload: {
      board_name: 'Prueba de saturación',
      actor_name: 'k6',
      preview: 'Prueba de rodilla',
    },
  };

  const res = http.post(
    `${base}/internal/events`,
    JSON.stringify(event),
    {
      headers: {
        'Content-Type': 'application/json',
        'X-Service-Token': token,
      },
      timeout: '10s',
    }
  );

  accepted.add(res.status === 202);
  check(res, { 'HTTP 202': r => r.status === 202 });
}
