# Prueba en vivo 03 - Rendimiento WebSocket de pixels-api (k6 ws_fanout.js)
# Pide por consola la cantidad de VUs, modo (0 ms baseline vs 50 ms variante) y duracion.
# Uso:
#   powershell -ExecutionPolicy Bypass -File ".\Pruebas en vivo\03-perf-pixels-ws.ps1"
#   powershell -ExecutionPolicy Bypass -File ".\Pruebas en vivo\03-perf-pixels-ws.ps1" -Vus 500 -BatchMs 50 -DurationS 30
param(
    [int]$Vus = 0,
    [int]$BatchMs = -1,
    [int]$DurationS = 0,
    [int]$WarmupS = 10,
    [string]$Project = "collaboard"
)

$ErrorActionPreference = "Stop"
$RootDir = (Resolve-Path "$PSScriptRoot\..").Path
$PixelsDir = Join-Path $RootDir "rendimiento\pixels"
$CertsDir = Join-Path $PixelsDir "certs"
$OutDir = Join-Path $PSScriptRoot "resultados"
New-Item -ItemType Directory -Force -Path $CertsDir | Out-Null
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

Write-Host "============================================================" -ForegroundColor Cyan
Write-Host " PRUEBA EN VIVO 03 - PIXELS-API WEBSOCKET FAN-OUT (k6)" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan

if ($Vus -le 0) {
    $inVus = Read-Host "Cuantos VUs (clientes WebSocket simultaneos) deseas lanzar? [default: 500]"
    $Vus = if ([string]::IsNullOrWhiteSpace($inVus)) { 500 } else { [int]$inVus }
}
if ($BatchMs -lt 0) {
    $inBatch = Read-Host "PIXELS_BATCH_INTERVAL_MS (0 = Baseline P2, 50 = Variante P3)? [default: 50]"
    $BatchMs = if ([string]::IsNullOrWhiteSpace($inBatch)) { 50 } else { [int]$inBatch }
}
if ($DurationS -le 0) {
    $inDur = Read-Host "Duracion de medicion en segundos (sin contar ${WarmupS}s de warmup)? [default: 30]"
    $DurationS = if ([string]::IsNullOrWhiteSpace($inDur)) { 30 } else { [int]$inDur }
}

Write-Host "`n>>> Levantando stack con PIXELS_BATCH_INTERVAL_MS=$BatchMs (override de rendimiento)..." -ForegroundColor Yellow
$env:PIXELS_BATCH_INTERVAL_MS = "$BatchMs"
docker compose -p $Project `
    -f "$RootDir\docker-compose.yml" `
    -f "$RootDir\notifications-module\compose.gateway.yml" `
    -f "$PixelsDir\compose.override.yml" `
    up -d --wait

# Extraer certificado CA vigente del gateway
$caPath = Join-Path $CertsDir "ca.crt"
docker exec "${Project}-gateway-1" cat /etc/nginx/certs/ca.crt | Set-Content -Path $caPath -Encoding ascii

$Tag = "live-ws-batch${BatchMs}-${Vus}vus-" + (Get-Date -Format "HHmmss")
$NetName = "${Project}_edge"

Write-Host "`n>>> Lanzando k6 WS: VUs=$Vus | Batch=${BatchMs}ms | Duracion=${DurationS}s (+${WarmupS}s warmup)..." -ForegroundColor Green
docker run --rm --cpus="6.0" --network $NetName `
    -v "${PixelsDir}\k6:/k6:ro" `
    -v "${OutDir}:/resultados" `
    -v "${CertsDir}:/certs:ro" `
    -e SSL_CERT_FILE=/certs/ca.crt `
    -e VUS=$Vus `
    -e DURATION_S=$DurationS `
    -e WARMUP_S=$WarmupS `
    -e WS_URL="wss://gateway/ws/pixels" `
    grafana/k6 run --summary-export="/resultados/${Tag}.json" /k6/ws_fanout.js

Write-Host "`nResumen guardado en: $OutDir\${Tag}.json" -ForegroundColor Cyan
