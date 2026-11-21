import http from 'k6/http';
import { check } from 'k6';
import { Rate, Trend } from 'k6/metrics';

const total = Number(__ENV.EVENTS || 500);
const vus = Number(__ENV.VUS || 25);
export const options = {
  scenarios: {burst:{executor:'shared-iterations',vus,iterations:total,maxDuration:'180s'}},
  thresholds: {http_req_failed:['rate<0.01'],http_req_duration:['p(95)<500']},
};
const success = new Rate('event_accepted');
const accept = new Trend('api_accept_duration_ms');
const base = __ENV.NOTIFICATIONS_API || 'http://notification-api:8080';
const runId = __ENV.RUN_ID || 's4demo';
const serviceToken = __ENV.NOTIFICATIONS_SERVICE_TOKEN || '';
if (!serviceToken) throw new Error('NOTIFICATIONS_SERVICE_TOKEN requerida');

export default function () {
  const eventId = `${runId}-${__VU}-${__ITER}`;
  const event = {
    event_id:eventId, type:'chat.message.created', occurred_at:new Date().toISOString(),
    actor_id:'perf-sender', board_id:'perf-board', recipient_ids:[`perf-receiver-${__VU}`],
    payload:{board_name:'Prueba de rendimiento',actor_name:'k6',preview:'Carga controlada'},
  };
  const res = http.post(`${base}/internal/events`,JSON.stringify(event),{
    headers:{'Content-Type':'application/json','X-Service-Token':serviceToken},
    timeout:'10s',
  });
  success.add(res.status===202);
  accept.add(res.timings.duration);
  check(res,{'aceptación 202':r=>r.status===202});
}
