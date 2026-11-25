# Prueba en vivo 06 - Mostrar resultados ya realizados y abrir graficas de evidencia
# Uso: powershell -ExecutionPolicy Bypass -File ".\Pruebas en vivo\06-resumen-pruebas-previas.ps1"
param(
    [switch]$AbrirGraficas
)

$ErrorActionPreference = "Continue"
$RootDir = (Resolve-Path "$PSScriptRoot\..").Path

Write-Host "==================================================================" -ForegroundColor Cyan
Write-Host " RESUMEN DE PRUEBAS YA REALIZADAS (P2 vs P3)" -ForegroundColor Cyan
Write-Host "==================================================================" -ForegroundColor Cyan

Write-Host "`n1) SEGURIDAD S3 - NETWORK SEGMENTATION (s3_segmentacion.py):" -ForegroundColor Yellow
Write-Host "   - Pares permitidos que conectan:            22/22 (P2) -> 22/22 (P3)"
Write-Host "   - Saltos prohibidos a bases/broker:          0/45 (P2) -> 45/45 bloqueados (P3)" -ForegroundColor Green
Write-Host "   - Saltos message-worker -> red app:           0/8 (P2) ->  8/8 bloqueados (P3)" -ForegroundColor Green
Write-Host "   - Contenedores internos sin Internet:        0/14 (P2) -> 14/14 bloqueados (P3)" -ForegroundColor Green

Write-Host "`n2) RENDIMIENTO - COSTO DE SEGMENTACION S3 (GET /api/pixels/stats @ 1500 req/s):" -ForegroundColor Yellow
Write-Host "   - P2 (red plana internal):    p50 = 1.23 ms | 0.00% errores"
Write-Host "   - P3 (8 redes segmentadas):   p50 = 1.38 ms (+0.15 ms) | 0.00% errores" -ForegroundColor Green

Write-Host "`n3) RENDIMIENTO - PIXELS-API WEBSOCKET FAN-OUT (1 CPU, ADR 0019):" -ForegroundColor Yellow
Write-Host "   - Baseline (batch=0 ms)  @  500 VUs: p95 =   274 ms | CPU 68.0% |   0% err"
Write-Host "   - Baseline (batch=0 ms)  @ 1000 VUs: p95 = 12624 ms | CPU 98.7% | 100% err (Lagged)" -ForegroundColor Red
Write-Host "   - Variante (batch=50 ms) @  500 VUs: p95 =    58 ms | CPU 35.6% |   0% err" -ForegroundColor Green
Write-Host "   - Variante (batch=50 ms) @ 1000 VUs: p95 =   137 ms | CPU 38.5% |   0% err (rodilla)" -ForegroundColor Green
Write-Host "   - Variante (batch=50 ms) @ 2000 VUs: p95 =  1852 ms | CPU 99.0% |   0% err (58.6x mas pixeles)" -ForegroundColor Green

Write-Host "`n4) RENDIMIENTO - GET /api/boards (E2 sin pausa, 30s):" -ForegroundColor Yellow
Write-Host "   - Original (1 CPU, pool 5+10) @   32 VUs:    152 TPM | 55.81% timeouts (15/15 idle in tx)" -ForegroundColor Red
Write-Host "   - Pool sin tope (6 workers)   @   32 VUs: 32 120 TPM |  0.00% err | p95 =  103 ms" -ForegroundColor Green
Write-Host "   - Pool sin tope (6 workers)   @  128 VUs: 30 746 TPM |  0.00% err | p95 =  436 ms (cumple SLO)" -ForegroundColor Green
Write-Host "   - Pool sin tope (6 workers)   @ 2000 VUs: 35 078 TPM |  0.00% err | p95 = 4735 ms" -ForegroundColor Green

$imgs = @(
    "$RootDir\docs\p3\evidencia\S3\s3-matriz-antes-despues.png",
    "$RootDir\docs\p3\evidencia\S3\s3-wireshark-antes-despues.png",
    "$RootDir\rendimiento\pixels\resultados\grafica-ws-latencia-throughput.png",
    "$RootDir\rendimiento\pixels\resultados\grafica-ws-cpu-mem.png",
    "$RootDir\rendimiento\pixels\resultados\grafica-costo-segmentacion.png"
)

if (-not $AbrirGraficas) {
    $resp = Read-Host "`nDeseas abrir las 5 graficas de evidencia ahora? (s/N)"
    if ($resp -match "^[sSyY]") { $AbrirGraficas = $true }
}

if ($AbrirGraficas) {
    foreach ($img in $imgs) {
        if (Test-Path $img) { Start-Process $img }
    }
}
