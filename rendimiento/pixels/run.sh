#!/bin/sh
# Ejecuta el banco de rendimiento de pixels-api (WS fan-out + costo de segmentación).
#   sh rendimiento/pixels/run.sh [baseline|variante|seg-p3|all] [proyecto]
set -eu

MODO="${1:-all}"
PROJECT="${2:-collaboard}"
DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
ROOT="$(CDPATH= cd -- "$DIR/../.." && pwd)"
OUT="$DIR/resultados"
mkdir -p "$OUT" "$DIR/certs"
NET="${PROJECT}_edge"

capture_stats() {
  tag="$1"
  f="$OUT/stats-${tag}.csv"
  echo "timestamp,name,cpu_pct,mem_usage,mem_pct" > "$f"
  while true; do
    ts=$(date +%s)
    docker stats --no-stream --format "{{.Name}},{{.CPUPerc}},{{.MemUsage}},{{.MemPerc}}" \
      "${PROJECT}-gateway-1" "${PROJECT}-pixels-api-1" "${PROJECT}-pixels-nosqldb-1" 2>/dev/null \
      | awk -v t="$ts" '{print t "," $0}' >> "$f" || true
    sleep 2
  done
}

run_ws() {
  tag="$1"; vus="$2"; dur="${3:-60}"; warm="${4:-10}"
  capture_stats "$tag" &
  pid=$!
  trap "kill $pid 2>/dev/null || true" EXIT INT TERM
  docker run --rm --cpus="6.0" --network "$NET" \
    -v "$DIR/k6:/k6:ro" -v "$OUT:/resultados" -v "$DIR/certs:/certs:ro" \
    -e SSL_CERT_FILE=/certs/ca.crt -e VUS="$vus" -e DURATION_S="$dur" -e WARMUP_S="$warm" \
    -e WS_URL="wss://gateway/ws/pixels" \
    grafana/k6 run --summary-export="/resultados/${tag}.json" /k6/ws_fanout.js || true
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  sleep 5
}

run_stats_http() {
  tag="$1"; rate="${2:-1500}"; dur="${3:-60}"
  capture_stats "$tag" &
  pid=$!
  docker run --rm --cpus="6.0" --network "$NET" \
    -v "$DIR/k6:/k6:ro" -v "$OUT:/resultados" -v "$DIR/certs:/certs:ro" \
    -e SSL_CERT_FILE=/certs/ca.crt -e RATE="$rate" -e DURATION_S="$dur" \
    -e STATS_URL="https://gateway/api/pixels/stats" \
    grafana/k6 run --summary-export="/resultados/${tag}.json" /k6/segmentation_overhead.js || true
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  sleep 3
}

bring_up() {
  PIXELS_BATCH_INTERVAL_MS="$1" docker compose -p "$PROJECT" \
    -f "$ROOT/docker-compose.yml" -f "$ROOT/notifications-module/compose.gateway.yml" \
    -f "$DIR/compose.override.yml" up -d --build --wait
}

if [ "$MODO" = "baseline" ] || [ "$MODO" = "all" ]; then
  bring_up 0
  run_ws A-ws-100-r1 100
  run_ws A-ws-500-r1 500; run_ws A-ws-500-r2 500; run_ws A-ws-500-r3 500
  run_ws A-ws-1000-r1 1000; run_ws A-ws-1000-r2 1000; run_ws A-ws-1000-r3 1000
  run_ws A-ws-2000-r1 2000
fi

if [ "$MODO" = "variante" ] || [ "$MODO" = "all" ]; then
  bring_up 50
  run_ws B-ws-100-r1 100
  run_ws B-ws-500-r1 500; run_ws B-ws-500-r2 500; run_ws B-ws-500-r3 500
  run_ws B-ws-1000-r1 1000; run_ws B-ws-1000-r2 1000; run_ws B-ws-1000-r3 1000
  run_ws B-ws-2000-r1 2000
fi

if [ "$MODO" = "seg-p3" ] || [ "$MODO" = "all" ]; then
  bring_up 50
  run_stats_http seg-p3-1500-r1 1500
  run_stats_http seg-p3-1500-r2 1500
  run_stats_http seg-p3-1500-r3 1500
fi

