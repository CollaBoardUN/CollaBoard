#!/bin/sh
# Prueba "costo de TLS" (P3 · S1): recorre configuraciones, endpoints y niveles con
# k6 en un contenedor conectado a la red edge del sistema bajo prueba.
#
#   sh rendimiento/tls/run.sh p3 <proyecto_compose>   # B, C, D (HTTPS)
#   sh rendimiento/tls/run.sh p2 <proyecto_compose>   # A (HTTP, baseline P2)
#
# El sistema debe estar arriba con rendimiento/tls/compose.override.yml (README).
# Niveles: HEALTHZ_RATES (llegadas/s, "500 1500 3000") y DASHBOARD_VUS ("5 10 25");
# el del medio (KEY) se repite REPS veces (3). DURATION (60s), PAUSE (10),
# K6_CPUS (6), OUT (rendimiento/tls/resultados).
set -eu
export MSYS_NO_PATHCONV=1   # Git Bash: no convertir rutas de los contenedores

system="${1:?p2 o p3}"
project="${2:?nombre del proyecto de Compose}"
HEALTHZ_RATES="${HEALTHZ_RATES:-500 1500 3000}"
HEALTHZ_KEY="${HEALTHZ_KEY:-1500}"
DASHBOARD_VUS="${DASHBOARD_VUS:-5 10 25}"
DASHBOARD_KEY="${DASHBOARD_KEY:-10}"
REPS="${REPS:-3}"
DURATION="${DURATION:-60s}"
PAUSE="${PAUSE:-10}"
K6_CPUS="${K6_CPUS:-6}"
here=$(cd "$(dirname "$0")" && (pwd -W 2>/dev/null || pwd))
OUT="${OUT:-$here/resultados}"
network="${project}_edge"
mkdir -p "$OUT"

case "$system" in
  p2) base=http://gateway;  configs="A-reuse:1:h1 A-new:0:h1" ;;
  p3) base=https://gateway; configs="C-reuse:1:h1 B-new:0:h1 D-h2:1:h2" ;;
  *) echo "sistema desconocido: $system" >&2; exit 2 ;;
esac
ca_dir="$here/certs"   # CA de la prueba (la crea el gateway con TLS_EXTRA_SAN=DNS:gateway)
mkdir -p "$ca_dir"
cacert=""
[ "$system" = p3 ] && cacert="--cacert /certs/ca.crt"

netshoot() { docker run --rm --network "$network" -v "$ca_dir:/certs:ro" nicolaka/netshoot "$@"; }

# Cuenta sembrada y token ANTES de medir: el login no contamina las latencias.
suffix=$(date +%s)
pass="Rendimiento-TLS-$suffix!"
body="{\"name\":\"perf $suffix\",\"email\":\"perf-tls-$suffix@ejemplo.com\",\"password\":\"$pass\",\"confirm_password\":\"$pass\"}"
token=$(netshoot curl -s $cacert -X POST "$base/api/auth/register" -H 'Content-Type: application/json' -d "$body" \
  | sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p')
[ -n "$token" ] || { echo "no se pudo registrar la cuenta de prueba en $base" >&2; exit 1; }
for i in 1 2 3 4 5; do
  netshoot curl -s -o /dev/null $cacert -X POST "$base/api/boards" \
    -H "Authorization: Bearer $token" -H 'Content-Type: application/json' -d "{\"name\":\"perf $i\"}"
done

# CPU y memoria por contenedor cada ~2 s, durante toda la corrida.
stats="$OUT/stats-$system.csv"
echo "epoch,container,cpu_pct,mem" > "$stats"
(
  while :; do
    now=$(date +%s)
    docker stats --no-stream --format '{{.Name}},{{.CPUPerc}},{{.MemUsage}}' 2>/dev/null \
      | grep -E "^${project}-(gateway|web-ssr|auth-api|collaboration-api)-|^k6-tls" \
      | sed "s/^/$now,/" >> "$stats" || true
    sleep 1
  done
) &
stats_pid=$!
trap 'kill $stats_pid 2>/dev/null || true' EXIT

index="$OUT/index-$system.csv"
[ -f "$index" ] || echo "config,endpoint,level,rep,start,end,file" > "$index"

run_k6() { # config reuse proto endpoint nivel duration file  (nivel: req/s en healthz, VUs en dashboard)
  godebug=""
  [ "$3" = "h1" ] && godebug="http2client=0"
  docker run --rm --name "k6-tls-$$" --network "$network" --cpus "$K6_CPUS" \
    -v "$ca_dir:/certs:ro" -v "$here/k6:/scripts:ro" -v "$OUT:/out" \
    -e SSL_CERT_FILE=/certs/ca.crt -e GODEBUG="$godebug" \
    -e BASE="$base" -e ENDPOINT="$4" -e DURATION="$6" -e REUSE="$2" -e TOKEN="$token" \
    -e RATE="$([ "$4" = healthz ] && echo "$5")" -e VUS="$([ "$4" = dashboard ] && echo "$5")" \
    grafana/k6 run --quiet --no-color ${7:+--summary-export "/out/$7"} /scripts/tls.js >/dev/null 2>&1 || true
}

for cfg in $configs; do
  name=${cfg%%:*}; rest=${cfg#*:}; reuse=${rest%%:*}; proto=${rest#*:}
  for endpoint in healthz dashboard; do
    if [ "$endpoint" = healthz ]; then levels=$HEALTHZ_RATES; key=$HEALTHZ_KEY; warm=200
    else levels=$DASHBOARD_VUS; key=$DASHBOARD_KEY; warm=5; fi
    echo "== $name · $endpoint: calentamiento"
    run_k6 "$name" "$reuse" "$proto" "$endpoint" "$warm" 10s ""
    for vus in $levels; do
      reps=1
      [ "$vus" = "$key" ] && reps=$REPS
      rep=1
      while [ "$rep" -le "$reps" ]; do
        file="$name-$endpoint-$vus-r$rep.json"
        echo "   nivel $vus (repetición $rep/$reps)"
        start=$(date +%s)
        run_k6 "$name" "$reuse" "$proto" "$endpoint" "$vus" "$DURATION" "$file"
        end=$(date +%s)
        echo "$name,$endpoint,$vus,$rep,$start,$end,$file" >> "$index"
        sleep "$PAUSE"
        rep=$((rep + 1))
      done
    done
  done
done
echo "Listo: resultados en $OUT"
