import http from 'k6/http';
import { check } from 'k6';

const VUS = Number(__ENV.VUS || 50);
const DURATION_S = Number(__ENV.DURATION_S || 20);
const URL = __ENV.STATS_URL || 'https://gateway/api/pixels/stats';

export const options = {
  scenarios: {
    live_http_vus: {
      executor: 'constant-vus',
      vus: VUS,
      duration: `${DURATION_S}s`,
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<100'],
  },
};

export default function () {
  const res = http.get(URL);
  check(res, { 'status 200': (r) => r.status === 200 });
}
