# Prueba en vivo 04 - Costo HTTP de segmentacion S3 (GET /api/pixels/stats con k6)
# Pide por consola la cantidad de VUs y duracion.
# Uso:
#   powershell -ExecutionPolicy Bypass -File ".\Pruebas en vivo\04-perf-segmentacion-http.ps1"
#   powershell -ExecutionPolicy Bypass -File ".\Pruebas en vivo\04-perf-segmentacion-http.ps1" -Vus 50 -DurationS 20
param(
    [int]$Vus = 0,
    [int]$DurationS = 0,
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
Write-Host " PRUEBA EN VIVO 04 - COSTO HTTP DE SEGMENTACION S3 (k6)" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan

if ($Vus -le 0) {
    $inVus = Read-Host "Cuantos VUs deseas lanzar contra GET /api/pixels/stats? [default: 50]"
    $Vus = if ([string]::IsNullOrWhiteSpace($inVus)) { 50 } else { [int]$inVus }
}
if ($DurationS -le 0) {
    $inDur = Read-Host "Duracion de la prueba en segundos? [default: 20]"
    $DurationS = if ([string]::IsNullOrWhiteSpace($inDur)) { 20 } else { [int]$inDur }
}

Write-Host "`n>>> Verificando stack con override de rendimiento (rate limit elevado)..." -ForegroundColor Yellow
$env:PIXELS_BATCH_INTERVAL_MS = "50"
docker compose -p $Project `
    -f "$RootDir\docker-compose.yml" `
    -f "$RootDir\notifications-module\compose.gateway.yml" `
    -f "$PixelsDir\compose.override.yml" `
    up -d --wait

$caPath = Join-Path $CertsDir "ca.crt"
docker exec "${Project}-gateway-1" cat /etc/nginx/certs/ca.crt | Set-Content -Path $caPath -Encoding ascii

$Tag = "live-seg-http-${Vus}vus-" + (Get-Date -Format "HHmmss")
$NetName = "${Project}_edge"

Write-Host "`n>>> Lanzando k6 HTTP: VUs=$Vus | Duracion=${DurationS}s | https://gateway/api/pixels/stats..." -ForegroundColor Green
docker run --rm --cpus="6.0" --network $NetName `
    -v "${PSScriptRoot}\k6:/k6:ro" `
    -v "${OutDir}:/resultados" `
    -v "${CertsDir}:/certs:ro" `
    -e SSL_CERT_FILE=/certs/ca.crt `
    -e VUS=$Vus `
    -e DURATION_S=$DurationS `
    -e STATS_URL="https://gateway/api/pixels/stats" `
    grafana/k6 run --summary-export="/resultados/${Tag}.json" /k6/http_stats_vus.js

Write-Host "`nResumen guardado en: $OutDir\${Tag}.json" -ForegroundColor Cyan
