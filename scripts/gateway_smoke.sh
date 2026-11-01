#!/bin/sh
# Verifica cada prefijo público del gateway y las garantías de seguridad.
#   sh scripts/gateway_smoke.sh [http://localhost:8088]
# Códigos esperados: 2xx/401/403/404 propios de cada API cuentan como "enrutado"
# (la petición llegó al servicio); 502/503 indican upstream caído o mal enrutado.
BASE="${1:-http://localhost:8088}"
fail=0

code() { curl -s -o /dev/null -w '%{http_code}' --max-time 8 "$@"; }

check() { # nombre, esperado(s) separados por |, comando curl...
  name="$1"; expected="$2"; shift 2
  got=$(code "$@")
  case "|$expected|" in
    *"|$got|"*) printf 'OK   %-46s %s\n' "$name" "$got" ;;
    *) printf 'FAIL %-46s %s (esperado %s)\n' "$name" "$got" "$expected"; fail=1 ;;
  esac
}

check "/healthz del gateway"            200               "$BASE/healthz"
check "/ (web SSR)"                     200\|302\|307     "$BASE/"
check "/login (web SSR)"                200               "$BASE/login"
check "/api/auth/me sin sesión"         401               "$BASE/api/auth/me"
check "/api/boards sin sesión"          401               "$BASE/api/boards"
check "/api/invites/x"                  401\|404          "$BASE/api/invites/x"
check "/api/canvas/.../state"           401\|403\|404     "$BASE/api/canvas/boards/abc/state"
check "/api/canvas/.../versions"        401\|403\|404     "$BASE/api/canvas/boards/abc/versions"
check "/api/chat/.../messages"          401               "$BASE/api/chat/boards/abc/messages"
check "/api/pixels/board"               200               "$BASE/api/pixels/board"
check "/api/notifications"              200\|401          "$BASE/api/notifications"
check "/api/notifications/{id}/read"    200\|401\|404     -X PATCH "$BASE/api/notifications/abc/read"

# /internal/* jamás se publica, ni anidado bajo otros prefijos
for p in /internal/events /internal/boards/x/access /api/internal/x /api/boards/internal/x /api/chat/internal/x /api/notifications/internal/events /INTERNAL/x /ws/internal/x; do
  check "bloqueado $p" 404 -X POST "$BASE$p"
done

# X-Request-ID: se genera y se respeta si es válido
rid=$(curl -s -o /dev/null -D - --max-time 8 "$BASE/healthz" | tr -d '\r' | awk -F': ' 'tolower($1)=="x-request-id"{print $2}')
if [ -n "$rid" ]; then echo "OK   X-Request-ID generado: $rid"; else echo "FAIL sin X-Request-ID"; fail=1; fi
echoed=$(curl -s -o /dev/null -D - --max-time 8 -H 'X-Request-ID: prueba-correlacion-123' "$BASE/healthz" | tr -d '\r' | awk -F': ' 'tolower($1)=="x-request-id"{print $2}')
if [ "$echoed" = "prueba-correlacion-123" ]; then echo "OK   X-Request-ID entrante respetado"; else echo "FAIL X-Request-ID entrante: '$echoed'"; fail=1; fi
bad=$(curl -s -o /dev/null -D - --max-time 8 -H 'X-Request-ID: malo con espacios y simbolos <>' "$BASE/healthz" | tr -d '\r' | awk -F': ' 'tolower($1)=="x-request-id"{print $2}')
case "$bad" in *" "*|*"<"*|"") echo "FAIL X-Request-ID inválido no sustituido: '$bad'"; fail=1 ;; *) echo "OK   X-Request-ID inválido sustituido: $bad" ;; esac

exit $fail
