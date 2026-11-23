import exec from 'k6/execution';
import { Counter, Trend } from 'k6/metrics';
import { boardNames, catalog, expect, request, signIn, userCount } from './catalog.js';

const experiment = __ENV.BOARDS_EXPERIMENT;
const warmup = Number(__ENV.BOARDS_WARMUP_SECONDS);
const seconds = Number(__ENV.BOARDS_MEASURE_SECONDS);
const level = Number(__ENV.BOARDS_LEVEL);
const runTag = __ENV.BOARDS_RUN_TAG;
const drain = 12;

function scenario(duration) {
  const load = experiment === 'E1'
    ? { executor: 'constant-arrival-rate', rate: level, timeUnit: '1s', preAllocatedVUs: 200 }
    : { executor: 'constant-vus', vus: level };
  return { ...load, duration: `${duration}s`, gracefulStop: `${drain}s` };
}

export const options = {
  insecureSkipTLSVerify: false,
  noConnectionReuse: false,
  noVUConnectionReuse: false,
  setupTimeout: '5m',
  summaryTrendStats: ['min', 'avg', 'max', 'p(50)', 'p(95)', 'p(99)'],
  scenarios: {
    warmup: scenario(warmup),
    measure: { ...scenario(seconds), startTime: `${warmup + drain}s` },
  },
  // Materialize the scenario submetric, including when samples only occur in warmup.
  thresholds: {
    'dropped_iterations{scenario:measure}': ['count>=0'],
    'dropped_iterations{scenario:warmup}': ['count>=0'],
  },
};

const outcomes = [
  'success', 'http_429', 'http_401_403', 'http_other_4xx', 'http_5xx',
  'http_unexpected', 'invalid_json', 'timeout', 'transport',
];
const counters = Object.fromEntries(outcomes.map(name => [name, new Counter(`boards_${name}`)]));
const protocols = { 'HTTP/1.0': 'http_10', 'HTTP/1.1': 'http_11', 'HTTP/2.0': 'http_20' };
const transportKeys = [...Object.values(protocols), 'http_other', 'tcp_setup', 'tls_handshake'];
const transport = Object.fromEntries(transportKeys.map(name => [name, new Counter(`boards_${name}`)]));
const attempted = new Counter('boards_attempted');
const latency = new Trend('boards_success_ms', true);
const rejected = new Trend('boards_429_ms', true);
const windowStart = new Trend('boards_window_start');
let recordedWindow = false;

export function setup() {
  const anonymous = request('GET', '/api/boards');
  expect(anonymous, 401, 'Verificar JWT obligatorio', 0);
  return Array.from({ length: userCount }, (_, i) => {
    const account = signIn(i + 1);
    const names = boardNames(i + 1);
    const response = request('GET', '/api/boards', null, account.token);
    expect(response, 200, 'Verificar catalogo antes de medir', i + 1);
    const checked = catalog(response, account, names);
    if (!checked || checked.size !== names.length) {
      throw new Error(`Catalogo incompleto para usuario sintetico ${i + 1}`);
    }
    return { ...account, names, ids: Object.fromEntries(checked) };
  });
}

function outcome(response, account) {
  const status = response.status;
  if (status === 0) return response.error_code === 1050 ? 'timeout' : 'transport';
  if (status === 429) return 'http_429';
  if (status === 401 || status === 403) return 'http_401_403';
  if (status >= 400 && status < 500) return 'http_other_4xx';
  if (status >= 500 && status < 600) return 'http_5xx';
  if (status !== 200) return 'http_unexpected';
  const boards = catalog(response, account, account.names);
  return boards && boards.size === account.names.length &&
    account.names.every(name => boards.get(name) === account.ids[name])
    ? 'success' : 'invalid_json';
}

export default function (accounts) {
  const measure = exec.scenario.name === 'measure';
  if (measure && !recordedWindow) {
    windowStart.add(exec.scenario.startTime);
    recordedWindow = true;
  }
  // Rotate accounts even at a single VU and keep credentials inside the process.
  const account = accounts[exec.scenario.iterationInTest % accounts.length];
  if (measure) attempted.add(1);
  const start = Date.now();
  const requestId = measure && runTag ? `boards-${runTag}-${exec.scenario.iterationInTest}` : '';
  const response = request('GET', '/api/boards', null, account.token, requestId);
  const elapsed = Date.now() - start;
  const result = outcome(response, account);
  if (!measure) return;
  counters[result].add(1);
  if (result === 'success') latency.add(elapsed);
  if (result === 'http_429') rejected.add(elapsed);
  if (response.status > 0) {
    transport[protocols[response.proto] || 'http_other'].add(1);
    if (response.timings.connecting > 0) transport.tcp_setup.add(1);
    if (response.timings.tls_handshaking > 0) transport.tls_handshake.add(1);
  }
}

export function handleSummary(data) {
  const count = name => data.metrics[name]?.values.count ?? 0;
  const percentiles = name => {
    const values = data.metrics[name]?.values;
    return values ? {
      mean: values.avg, max: values.max, p50: values['p(50)'], p95: values['p(95)'], p99: values['p(99)'],
    } : null;
  };
  return { stdout: 'BOARDS_SUMMARY ' + JSON.stringify({
    experiment, level, seconds, warmup,
    window_start_ms: data.metrics.boards_window_start?.values.min ?? null,
    attempted: count('boards_attempted'),
    dropped: count('dropped_iterations{scenario:measure}'),
    warmup_dropped: count('dropped_iterations{scenario:warmup}'),
    outcomes: Object.fromEntries(outcomes.map(name => [name, count(`boards_${name}`)])),
    protocol: {
      reuse_enabled: true,
      ...Object.fromEntries(transportKeys.map(name => [name, count(`boards_${name}`)])),
    },
    latency_success_ms: percentiles('boards_success_ms'),
    latency_429_ms: percentiles('boards_429_ms'),
  }) + '\n' };
}
