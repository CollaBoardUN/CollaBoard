#!/bin/sh
# Prueba "costo del Authorizer RBAC y efecto de la caché del PEP" (P3 · S5).
# Recorre las configuraciones TTL ∈ {0, 1, 5, 30} s con una sola variable por comparación,
# recreando únicamente los contenedores pizarra-api, chat-api y collaboration-api con el nuevo TTL
# y corriendo k6 desde un contenedor en la red edge del proyecto.
#
#   sh rendimiento/rbac/run.sh <proyecto_compose>
#
# Variables ajustables:
#   TTLS="0 1 5 30"           # TTL en segundos a evaluar (0 = sin caché, baseline)
#   VUS_LEVELS="10 25 50"     # niveles de concurrencia (VUs)
#   KEY_VUS="25"              # nivel clave con REPS repeticiones
#   REPS="3"                  # repeticiones en el nivel clave
#   DURATION="60s"            # duración por corrida
#   PAUSE="10"                # segundos entre corridas
#   K6_CPUS="6"               # CPUs asignadas al contenedor generador k6
#   BASE="http://gateway"     # o https://gateway si se corre tras integrar S1
set -eu
export MSYS_NO_PATHCONV=1

project="${1:-collaboard}"
TTLS="${TTLS:-0 1 5 30}"
VUS_LEVELS="${VUS_LEVELS:-10 25 50}"
KEY_VUS="${KEY_VUS:-25}"
REPS="${REPS:-3}"
DURATION="${DURATION:-60s}"
PAUSE="${PAUSE:-10}"
K6_CPUS="${K6_CPUS:-6}"
BASE="${BASE:-http://gateway}"

here=$(cd "$(dirname "$0")" && (pwd -W 2>/dev/null || pwd))
root=$(cd "$here/../.." && (pwd -W 2>/dev/null || pwd))
OUT="${OUT:-$here/resultados}"
network="${project}_edge"
mkdir -p "$OUT"

compose_cmd="docker compose -p $project -f $root/docker-compose.yml -f $root/notifications-module/compose.gateway.yml -f $here/compose.override.yml"
netshoot() { docker run --rm --network "$network" nicolaka/netshoot "$@"; }

# 1. Sembrar usuario owner, usuario editor y tablero compartido ANTES de medir.
suffix=$(date +%s)
pass="Rendimiento-RBAC-$suffix!"
owner_body="{\"name\":\"owner $suffix\",\"email\":\"owner-rbac-$suffix@ejemplo.com\",\"password\":\"$pass\",\"confirm_password\":\"$pass\"}"
editor_body="{\"name\":\"editor $suffix\",\"email\":\"editor-rbac-$suffix@ejemplo.com\",\"password\":\"$pass\",\"confirm_password\":\"$pass\"}"

owner_json=$(netshoot curl -s -X POST "$BASE/api/auth/register" -H 'Content-Type: application/json' -d "$owner_body")
owner_token=$(echo "$owner_json" | sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p')
editor_json=$(netshoot curl -s -X POST "$BASE/api/auth/register" -H 'Content-Type: application/json' -d "$editor_body")
editor_token=$(echo "$editor_json" | sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p')
editor_id=$(echo "$editor_json" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')

[ -n "$owner_token" ] && [ -n "$editor_token" ] || { echo "No se pudieron sembrar las cuentas en $BASE" >&2; exit 1; }

board_json=$(netshoot curl -s -X POST "$BASE/api/boards" \
  -H "Authorization: Bearer $owner_token" -H 'Content-Type: application/json' \
  -d "{\"name\":\"Tablero RBAC Perf $suffix\"}")
board_id=$(echo "$board_json" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')

# Invitar y unir al editor (o añadir por invitación)
inv_json=$(netshoot curl -s -X POST "$BASE/api/boards/$board_id/invites" \
  -H "Authorization: Bearer $owner_token" -H 'Content-Type: application/json' \
  -d "{\"email\":\"editor-rbac-$suffix@ejemplo.com\",\"role\":\"editor\"}")
inv_token=$(echo "$inv_json" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
netshoot curl -s -o /dev/null -X POST "$BASE/api/invites/$inv_token/accept" \
  -H "Authorization: Bearer $editor_token"

echo "Tablero sembrado: $board_id (editor_id=$editor_id)"

# 2. Captura de EXPLAIN (ANALYZE, BUFFERS) del índice compuesto uq_board_user en board-db
docker exec "${project}-board-db-1" psql -U postgres -d boarddb -c \
  "EXPLAIN (ANALYZE, BUFFERS) SELECT role FROM board_members WHERE board_id = '$board_id' AND user_id = '$editor_id';" \
  > "$OUT/explain-uq-board-user.txt" 2>&1 || true

# 3. Muestreo de CPU y memoria por contenedor cada 1 s
stats="$OUT/stats-rbac.csv"
echo "epoch,container,cpu_pct,mem" > "$stats"
(
  while :; do
    now=$(date +%s)
    docker stats --no-stream --format '{{.Name}},{{.CPUPerc}},{{.MemUsage}}' 2>/dev/null \
      | grep -E "^${project}-(gateway|collaboration-api|pizarra-api|chat-api|board-db|canvas-db|chat-db)-|^k6-rbac" \
      | sed "s/^/$now,/" >> "$stats" || true
    sleep 1
  done
) &
stats_pid=$!
trap 'kill $stats_pid 2>/dev/null || true' EXIT

index="$OUT/index-rbac.csv"
[ -f "$index" ] || echo "ttl_s,endpoint,vus,rep,start,end,file" > "$index"

run_k6() { # ttl endpoint vus duration summary_file
  docker run --rm --name "k6-rbac-$$" --network "$network" --cpus "$K6_CPUS" \
    -v "$here/k6:/scripts:ro" -v "$OUT:/out" \
    -e BASE="$BASE" -e ENDPOINT="$2" -e TOKEN="$editor_token" -e BOARD_ID="$board_id" \
    -e VUS="$3" -e DURATION="$4" \
    grafana/k6 run --quiet --no-color ${5:+--summary-export "/out/$5"} /scripts/rbac_cache.js >/dev/null 2>&1 || true
}

for ttl in $TTLS; do
  ttl_ms=$((ttl * 1000))
  echo "== Configurando TTL=${ttl}s (CHAT_PERMISSION_CACHE_TTL_MS=${ttl_ms}ms) =="
  AUTHZ_CACHE_TTL_SECONDS="$ttl" CHAT_PERMISSION_CACHE_TTL_MS="$ttl_ms" \
    $compose_cmd up -d --wait collaboration-api pizarra-api chat-api

  for endpoint in canvas mixed; do
    echo "   Calentamiento ($endpoint, TTL=${ttl}s)"
    run_k6 "$ttl" "$endpoint" 5 10s ""
    for vus in $VUS_LEVELS; do
      reps=1
      [ "$vus" = "$KEY_VUS" ] && reps=$REPS
      rep=1
      while [ "$rep" -le "$reps" ]; do
        file="ttl${ttl}s-${endpoint}-vus${vus}-r${rep}.json"
        echo "   TTL=${ttl}s · $endpoint · ${vus} VUs (rep $rep/$reps)"
        start=$(date +%s)
        run_k6 "$ttl" "$endpoint" "$vus" "$DURATION" "$file"
        end=$(date +%s)
        echo "$ttl,$endpoint,$vus,$rep,$start,$end,$file" >> "$index"
        sleep "$PAUSE"
        rep=$((rep + 1))
      done
    done
  done
done

echo "Listo: resultados guardados en $OUT"
