import http from 'k6/http';
import { check, sleep } from 'k6';

const VUS = Number(__ENV.VUS || 10);
const DURATION_S = Number(__ENV.DURATION_S || 30);
const BASE_URL = __ENV.BASE_URL || 'https://gateway';
const TOKEN = __ENV.TOKEN || '';

export const options = {
  insecureSkipTLSVerify: true,
  noConnectionReuse: false,
  scenarios: {
    curva: {
      executor: 'constant-vus',
      vus: VUS,
      duration: `${DURATION_S}s`,
      gracefulStop: '15s',
    },
  },
  summaryTrendStats: ['min', 'avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

export default function () {
  const res = http.get(`${BASE_URL}/api/boards`, {
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/json',
    },
    timeout: '60s',
    tags: { name: 'GET /api/boards' },
  });
  check(res, {
    'status 200': (r) => r.status === 200,
  });
  sleep(1);
}
