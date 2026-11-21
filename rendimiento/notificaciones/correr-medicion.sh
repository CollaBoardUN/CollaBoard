#!/usr/bin/env bash
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

WORKERS="${1:-}"
case "$WORKERS" in
  1|2|4|6|8|12|16) ;;
  *) echo "Uso: bash rendimiento/notificaciones/correr-medicion.sh {1|2|4|6|8|12|16}"; exit 1 ;;
esac

FILES=(
  -f docker-compose.yml
  -f notifications-module/compose.gateway.yml
  -f rendimiento/notificaciones/compose.override.yml
)

EVENTS=500
RUN_ID="s4med-w${WORKERS}-$(date +%s)-${RANDOM}"
FOLDER="rendimiento/notificaciones/results"
STARTED="$FOLDER/$RUN_ID.start"
FINISHED="$FOLDER/$RUN_ID.done"

mkdir -p "$FOLDER"

printf 'run_id=%s\nworkers=%s\nprefetch=1\ndelay_ms=200\nevents=500\nvus=25\n' \
  "$RUN_ID" "$WORKERS" > "$FOLDER/$RUN_ID.meta"

restaurar() {
  echo "=== Restaurando 4 workers, sin retraso ==="
  sudo env WORKER_PREFETCH=1 WORKER_TEST_DELAY_MS=0 \
    docker compose "${FILES[@]}" up -d --no-deps \
    --force-recreate --scale message-worker=4 message-worker
}

trap restaurar EXIT

echo "=== Experimento: $WORKERS workers ==="
echo "RUN_ID=$RUN_ID"

sudo env WORKER_PREFETCH=1 WORKER_TEST_DELAY_MS=200 \
  docker compose "${FILES[@]}" up -d --no-deps \
  --force-recreate --scale "message-worker=$WORKERS" message-worker

python3 -u rendimiento/notificaciones/medir-cola.py \
  "$RUN_ID" "$EVENTS" "$STARTED" "$FINISHED" \
  > "$FOLDER/$RUN_ID-monitor.log" 2>&1 &

MON_PID=$!

sleep 4
date +%s.%N > "$STARTED"

echo "=== Ejecutando carga k6 ==="

if sudo env RUN_ID="$RUN_ID" EVENTS=500 VUS=25 \
  WORKER_PREFETCH=1 WORKER_TEST_DELAY_MS=200 \
  docker compose "${FILES[@]}" --profile benchmark \
  run --rm k6-notifications run \
  --summary-export "/bench/results/$RUN_ID.json" \
  /bench/k6/burst.js \
  > "$FOLDER/$RUN_ID-k6.log" 2>&1; then
  K6_STATUS=0
else
  K6_STATUS=$?
fi

touch "$FINISHED"

echo "=== Esperando el drenaje de la cola ==="

if wait "$MON_PID"; then
  MON_STATUS=0
else
  MON_STATUS=$?
fi

echo
cat "$FOLDER/$RUN_ID-monitor.log"

echo
echo "=== Métricas k6 ==="
grep -E 'http_req_duration|http_req_failed|http_reqs' \
  "$FOLDER/$RUN_ID-k6.log" || true

echo
echo "Estado k6: $K6_STATUS"
echo "Estado monitoreo: $MON_STATUS"
echo "RUN_ID=$RUN_ID"

if [ "$MON_STATUS" -ne 0 ] || [ "$K6_STATUS" -ne 0 ]; then
  echo "ATENCIÓN: revisar los registros de esta corrida."
  exit 1
fi
