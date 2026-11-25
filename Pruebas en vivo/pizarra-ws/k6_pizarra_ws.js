import ws from 'k6/ws';
import { Counter, Rate, Trend } from 'k6/metrics';

const VUS = Number(__ENV.VUS || 10);
const WARMUP_S = Number(__ENV.WARMUP_S || 10);
const DURATION_S = Number(__ENV.DURATION_S || 30);
const BASE_WS = __ENV.BASE_WS || 'wss://gateway/ws/boards';
const BOARDS = (__ENV.BOARD_IDS || '').split(',').filter(Boolean);
const TOKENS = (__ENV.TOKENS || '').split(',').filter(Boolean);

export const wsAckRtt = new Trend('ws_ack_rtt_ms', true);
export const wsMessagesReceived = new Counter('ws_messages_received');
export const wsOpsSent = new Counter('ws_ops_sent');
export const wsAcksReceived = new Counter('ws_acks_received');
export const wsErrors = new Rate('ws_errors');

export const options = {
  insecureSkipTLSVerify: true,
  scenarios: {
    pizarra_ws: {
      executor: 'constant-vus',
      vus: VUS,
      duration: `${WARMUP_S + DURATION_S}s`,
      gracefulStop: '6s',
    },
  },
  summaryTrendStats: ['min', 'avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

export default function () {
  const startMs = Date.now();
  const warmupEndMs = startMs + WARMUP_S * 1000;
  const sessionMs = Math.max(8000, (WARMUP_S + DURATION_S - 2) * 1000);

  const token = TOKENS[(__VU - 1) % TOKENS.length];
  const boardId = BOARDS[(__VU - 1) % BOARDS.length];
  const wsUrl = `${BASE_WS}/${boardId}?token=${token}`;
  const elementId = `el-vu-${__VU}`;

  let refSeq = 0;
  const pendingAcks = new Map(); // ref -> { ts, measured }
  let synced = false;
  let closedCleanly = false;

  const res = ws.connect(wsUrl, {}, function (socket) {
    socket.on('open', function () {
      const jitter = 50 + (__VU % 25) * 40;
      socket.setTimeout(function () {
        const tick = () => {
          const now = Date.now();
          const inMeasure = now >= warmupEndMs;
          refSeq += 1;
          const x = Math.floor(Math.random() * 1000);
          const y = Math.floor(Math.random() * 800);

          // 1) Enviar operacion real de dibujo (add idempotente por VU -> ejerce lock, PEP, broadcast, ack y autosave)
          pendingAcks.set(refSeq, { ts: now, measured: inMeasure });
          socket.send(JSON.stringify({
            type: 'ops',
            ref: refSeq,
            ops: [{
              op: 'add',
              element: {
                id: elementId,
                type: 'rectangle',
                x: x,
                y: y,
                width: 60,
                height: 40,
                strokeWidth: 2,
                strokeColor: '#2563EB',
                fillColor: '#DBEAFE',
              },
            }],
          }));
          if (inMeasure) wsOpsSent.add(1);

          // 2) Enviar cursor efimero (ejerce fan-out O(N^2))
          socket.send(JSON.stringify({ type: 'cursor', x: x, y: y }));
        };
        tick();
        socket.setInterval(tick, 1000);
      }, jitter);

      socket.setTimeout(function () {
        closedCleanly = true;
        socket.close();
      }, sessionMs);
    });

    socket.on('message', function (raw) {
      const now = Date.now();
      const inMeasure = now >= warmupEndMs;
      if (inMeasure) wsMessagesReceived.add(1);

      try {
        const msg = JSON.parse(raw);
        if (msg.type === 'sync') {
          synced = true;
        } else if (msg.type === 'ack' && msg.ref !== undefined) {
          const entry = pendingAcks.get(msg.ref);
          if (entry) {
            pendingAcks.delete(msg.ref);
            if (entry.measured) {
              wsAckRtt.add(Math.max(0, now - entry.ts));
              wsAcksReceived.add(1);
            }
          }
        } else if (msg.type === 'error') {
          wsErrors.add(1);
        }
      } catch (_) {
        wsErrors.add(1);
      }
    });

    socket.on('error', function () {
      wsErrors.add(1);
    });

    socket.on('close', function () {
      // Cierre prematuro o sin haber completado el sync inicial cuenta como error
      if (!closedCleanly || !synced) {
        wsErrors.add(1);
      } else {
        wsErrors.add(0);
      }
    });
  });

  if (!res || res.status !== 101) {
    wsErrors.add(1);
  }
}
