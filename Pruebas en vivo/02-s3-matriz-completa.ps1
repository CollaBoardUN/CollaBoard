# Prueba en vivo 02 - S3 Network Segmentation (matriz completa de 89 caminos)
# Uso: powershell -ExecutionPolicy Bypass -File ".\Pruebas en vivo\02-s3-matriz-completa.ps1"
$ErrorActionPreference = "Stop"
$RootDir = (Resolve-Path "$PSScriptRoot\..").Path

Write-Host "============================================================" -ForegroundColor Cyan
Write-Host " PRUEBA EN VIVO 02 - MATRIZ COMPLETA S3 (89 CAMINOS)" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "Esperado: 22/22 permitidos, 45/45 datos/broker bloqueados, 8/8 worker->app bloqueados, 14/14 sin Internet.`n" -ForegroundColor Gray

Push-Location $RootDir
try {
    python .\security-tests\s3_segmentacion.py
} finally {
    Pop-Location
}
