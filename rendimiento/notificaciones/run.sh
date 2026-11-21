#!/usr/bin/env bash
set -euo pipefail
# Desde la raíz del clon; Requires Docker + Compose y .env (no versionarlo).
: "${EVENTS:=500}" "${VUS:=25}" "${WORKER_PREFETCH:=1}" "${WORKER_TEST_DELAY_MS:=0}" "${WORKERS:=1}"
export EVENTS VUS WORKER_PREFETCH WORKER_TEST_DELAY_MS
export RUN_ID="${RUN_ID:-$(date +%s)-$(printf %04d "$RANDOM")}" # evitar deduplicación entre corridas
mkdir -p rendimiento/notificaciones/results
printf 'run_id=%s\nworkers=%s\nprefetch=%s\ndelay_ms=%s\nevents=%s\nvus=%s\n' \
  "$RUN_ID" "$WORKERS" "$WORKER_PREFETCH" "$WORKER_TEST_DELAY_MS" "$EVENTS" "$VUS" \
  > "rendimiento/notificaciones/results/${RUN_ID}.meta"
FILES=(-f docker-compose.yml -f notifications-module/compose.gateway.yml -f rendimiento/notificaciones/compose.override.yml)
docker compose "${FILES[@]}" up -d --build --scale "message-worker=${WORKERS}" --wait
# k6 está en la red del stack y accede a /internal/events sin exponer el puerto al host.
docker compose "${FILES[@]}" --profile benchmark run --rm k6-notifications run \
    --summary-export "/bench/results/${RUN_ID}.json" /bench/k6/burst.js
