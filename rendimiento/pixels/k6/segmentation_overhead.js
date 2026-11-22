import http from 'k6/http';
import { check } from 'k6';

const RATE = Number(__ENV.RATE || 1500);
const DURATION_S = Number(__ENV.DURATION_S || 60);
const URL = __ENV.STATS_URL || 'https://gateway/api/pixels/stats';

export const options = {
  scenarios: {
    warmup: {
      executor: 'constant-arrival-rate',
      rate: Math.min(500, RATE),
      timeUnit: '1s',
      duration: '10s',
      preAllocatedVUs: 32,
      maxVUs: 200,
    },
    measure: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: `${DURATION_S}s`,
      startTime: '10s',
      preAllocatedVUs: 64,
      maxVUs: 400,
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

