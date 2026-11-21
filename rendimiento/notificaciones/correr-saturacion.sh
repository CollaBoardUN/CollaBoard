#!/usr/bin/env bash
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

WORKERS="${1:-8}"
RATE="${2:-10}"
DURATION_S=60

if ! [[ "$WORKERS" =~ ^[0-9]+$ && "$RATE" =~ ^[0-9]+$ ]] ||
   (( WORKERS < 1 || WORKERS > 32 || RATE < 1 || RATE > 120 )); then
  echo "Uso: $0 WORKERS(1-32) RATE(1-120)"
  exit 1
fi

FILES=(
  -f docker-compose.yml
  -f notifications-module/compose.gateway.yml
  -f rendimiento/notificaciones/compose.override.yml
)

EXPECTED=$((RATE * DURATION_S))
RUN_ID="s4sat-w${WORKERS}-r${RATE}-$(date +%s)-${RANDOM}"
FOLDER="rendimiento/notificaciones/results"

mkdir -p "$FOLDER"

STARTED="$FOLDER/$RUN_ID.start"
FINISHED="$FOLDER/$RUN_ID.done"

printf 'run_id=%s\nworkers=%s\nrate=%s\nduration_s=%s\nprefetch=1\ndelay_ms=200\nexpected=%s\n' \
  "$RUN_ID" "$WORKERS" "$RATE" "$DURATION_S" "$EXPECTED" \
  > "$FOLDER/$RUN_ID.meta"

restaurar() {
  echo "=== Restaurando 4 workers sin retraso ==="
  sudo env WORKER_PREFETCH=1 WORKER_TEST_DELAY_MS=0 \
    docker compose "${FILES[@]}" up -d --no-deps \
      --force-recreate --scale message-worker=4 message-worker
}

trap restaurar EXIT

echo "=== Saturación: $WORKERS workers, $RATE eventos/s ==="
echo "RUN_ID=$RUN_ID"
echo "Eventos programados=$EXPECTED"

sudo env WORKER_PREFETCH=1 WORKER_TEST_DELAY_MS=200 \
  docker compose "${FILES[@]}" up -d --no-deps \
    --force-recreate --scale "message-worker=$WORKERS" message-worker

MONITOR_TIMEOUT_S=600 python3 -u \
  rendimiento/notificaciones/medir-saturacion.py \
  "$RUN_ID" "$EXPECTED" "$STARTED" "$FINISHED" \
  > "$FOLDER/$RUN_ID-monitor.log" 2>&1 &

MON_PID=$!

sleep 4
date +%s.%N > "$STARTED"

if sudo env RUN_ID="$RUN_ID" \
  docker compose "${FILES[@]}" --profile benchmark \
  run --rm \
    -e RATE="$RATE" \
    -e DURATION_S="$DURATION_S" \
    k6-notifications run \
    --summary-export "/bench/results/$RUN_ID.json" \
    /bench/k6/tasa.js \
    > "$FOLDER/$RUN_ID-k6.log" 2>&1; then
  K6_STATUS=0
else
  K6_STATUS=$?
fi

touch "$FINISHED"

if wait "$MON_PID"; then
  MON_STATUS=0
else
  MON_STATUS=$?
fi

cat "$FOLDER/$RUN_ID-monitor.log"

echo
echo "=== Resultados k6 ==="
grep -E 'http_req_duration|http_req_failed|http_reqs|dropped_iterations' \
  "$FOLDER/$RUN_ID-k6.log" || true

echo
echo "Estado k6: $K6_STATUS"
echo "Estado monitor: $MON_STATUS"
echo "RUN_ID=$RUN_ID"
echo "Evidencia: $FOLDER"

if (( K6_STATUS != 0 || MON_STATUS != 0 )); then
  echo "ATENCIÓN: umbral incumplido o monitoreo incompleto."
  exit 1
fi
