# Prueba en vivo 01 - S3 Network Segmentation (ataque desde contenedor comprometido)
# Uso: powershell -ExecutionPolicy Bypass -File ".\Pruebas en vivo\01-s3-segmentacion-ataque.ps1"
param(
    [string]$Project = "collaboard"
)

$ErrorActionPreference = "Continue"

Write-Host "============================================================" -ForegroundColor Cyan
Write-Host " PRUEBA EN VIVO 01 - S3 NETWORK SEGMENTATION (ATAQUE VIVO)" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan

Write-Host "`n[1/3] Verificando las 8 redes Docker y atributo Internal=true..." -ForegroundColor Yellow
docker network ls --filter "name=${Project}_" --format "table {{.Name}}\t{{.Driver}}"
Write-Host ""
$nets = @("edge","app","net-user","net-board","net-canvas","net-notif","net-mongo","net-mq")
foreach ($n in $nets) {
    $full = "${Project}_$n"
    $val = docker network inspect $full --format "{{.Internal}}" 2>$null
    if ($val) {
        Write-Host ("  {0,-24} -> Internal = {1}" -f $full, $val)
    }
}

Write-Host "`n[2/3] Simulando atacante dentro de pixels-api (servicio menos critico)..." -ForegroundColor Yellow
docker run --rm --net="container:${Project}-pixels-api-1" nicolaka/netshoot sh -c "
  echo '  -> Intento lateral a user-db:5432 (debe FALLAR):'
  nc -zv -w 2 user-db 5432 2>&1 | sed 's/^/     /'
  echo '  -> Intento de salida a Internet 1.1.1.1:443 (debe FALLAR):'
  nc -zv -w 2 1.1.1.1 443 2>&1 | sed 's/^/     /'
  echo '  -> Acceso legitimo a su propia BD pixels-nosqldb:27017 (debe ABRIR):'
  nc -zv -w 2 pixels-nosqldb 27017 2>&1 | sed 's/^/     /'
"

Write-Host "`n[3/3] Verificando aislamiento de message-worker (fuera de app)..." -ForegroundColor Yellow
docker run --rm --net="container:${Project}-message-worker-1" nicolaka/netshoot sh -c "
  echo '  -> Intento hacia auth-api:8001 en red app (debe FALLAR):'
  nc -zv -w 2 auth-api 8001 2>&1 | sed 's/^/     /'
  echo '  -> Acceso legitimo a rabbitmq:5672 (debe ABRIR):'
  nc -zv -w 2 rabbitmq 5672 2>&1 | sed 's/^/     /'
  echo '  -> Acceso legitimo a notification-db:5432 (debe ABRIR):'
  nc -zv -w 2 notification-db 5432 2>&1 | sed 's/^/     /'
"

Write-Host "`nPrueba 01 finalizada." -ForegroundColor Green
