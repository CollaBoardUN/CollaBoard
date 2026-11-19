import ws from 'k6/ws';
import { Counter, Rate, Trend } from 'k6/metrics';

const VUS = Number(__ENV.VUS || 100);
const DURATION_S = Number(__ENV.DURATION_S || 60);
const WARMUP_S = Number(__ENV.WARMUP_S || 10);
const WS_URL = __ENV.WS_URL || 'wss://gateway/ws/pixels';

export const wsBroadcastLatency = new Trend('ws_broadcast_latency_ms', true);
export const wsMessagesReceived = new Counter('ws_messages_received');
export const wsPixelsSent = new Counter('ws_pixels_sent');
export const wsErrors = new Rate('ws_errors');

export const options = {
  scenarios: {
    ws_clients: {
      executor: 'constant-vus',
      vus: VUS,
      duration: `${DURATION_S + WARMUP_S}s`,
      gracefulStop: '5s',
    },
  },
  thresholds: {
    ws_broadcast_latency_ms: ['p(95)<250', 'p(99)<500'],
    ws_errors: ['rate<0.01'],
  },
};

const PALETTE = ['#FF4500', '#FFA800', '#00A368', '#3690EA', '#B44AC0', '#000000'];

export default function () {
  const startMs = Date.now();
  const warmupEndMs = startMs + WARMUP_S * 1000;
  const sessionMs = (DURATION_S + WARMUP_S - 2) * 1000;
  const userId = `vu-${__VU}`;
  const color = PALETTE[__VU % PALETTE.length];

  const res = ws.connect(WS_URL, {}, function (socket) {
    let closedCleanly = false;

    socket.on('open', function () {
      // Escalonar el primer envío (>0 ms, requisito de k6/ws setTimeout)
      const initialJitterMs = 50 + (__VU % 50) * 100;
      socket.setTimeout(function () {
        const sendPixel = () => {
          const x = Math.floor(Math.random() * 200);
          const y = Math.floor(Math.random() * 200);
          socket.send(JSON.stringify({
            type: 'PLACE_PIXEL',
            x: x,
            y: y,
            color: color,
            userId: userId,
          }));
          if (Date.now() >= warmupEndMs) {
            wsPixelsSent.add(1);
          }
        };
        sendPixel();
        socket.setInterval(sendPixel, 5200);
      }, initialJitterMs);

      socket.setTimeout(function () {
        closedCleanly = true;
        socket.close();
      }, sessionMs);
    });

    socket.on('message', function (raw) {
      if (Date.now() < warmupEndMs) {
        return;
      }
      wsMessagesReceived.add(1);
      try {
        const msg = JSON.parse(raw);
        if (msg.type === 'PIXEL_UPDATED' && msg.timestamp) {
          const sentTs = Date.parse(msg.timestamp);
          if (!Number.isNaN(sentTs)) {
            const lat = Math.max(0, Date.now() - sentTs);
            wsBroadcastLatency.add(lat);
          }
        }
      } catch (_) {
        wsErrors.add(1);
      }
    });

    socket.on('error', function () {
      wsErrors.add(1);
    });

    socket.on('close', function () {
      if (!closedCleanly && Date.now() < startMs + sessionMs - 1000) {
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

