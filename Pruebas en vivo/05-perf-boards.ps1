# Prueba en vivo 05 · Rendimiento GET /api/boards (k6 boards_list.js)
# Pide por consola la cantidad de VUs, variante (Original o Pool) y duracion.
# Uso:
#   powershell -ExecutionPolicy Bypass -File ".\Pruebas en vivo\05-perf-boards.ps1"
#   powershell -ExecutionPolicy Bypass -File ".\Pruebas en vivo\05-perf-boards.ps1" -Vus 32 -Variant Original -DurationS 30
param(
    [int]$Vus = 0,
    [string]$Variant = "",
    [int]$DurationS = 0
)

$ErrorActionPreference = "Stop"
$RootDir = (Resolve-Path "$PSScriptRoot\..").Path
$BoardsScript = Join-Path $RootDir "rendimiento\boards\run.ps1"

if (-not (Test-Path $BoardsScript)) {
    throw "No se encontro $BoardsScript. Asegurate de tener la carpeta rendimiento/boards disponible."
}

# Agregar Git de GitHub Desktop al PATH si git no esta disponible globalmente
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    $ghGit = Get-ChildItem "$env:LOCALAPPDATA\GitHubDesktop\app-*\resources\app\git\cmd" -ErrorAction SilentlyContinue |
        Sort-Object FullName -Descending | Select-Object -First 1
    if ($ghGit) { $env:PATH = "$($ghGit.FullName);$env:PATH" }
}

Write-Host "============================================================" -ForegroundColor Cyan
Write-Host " PRUEBA EN VIVO 05 · RENDIMIENTO GET /api/boards (k6)" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan

if ($Vus -le 0) {
    $inVus = Read-Host "Cuantos VUs deseas lanzar (1..2000)? [default: 32]"
    $Vus = if ([string]::IsNullOrWhiteSpace($inVus)) { 32 } else { [int]$inVus }
}
if ([string]::IsNullOrWhiteSpace($Variant)) {
    $inVar = Read-Host "Variante (Original / Pool)? [default: Original]"
    $Variant = if ([string]::IsNullOrWhiteSpace($inVar)) { "Original" } else { $inVar }
}
if ($DurationS -le 0) {
    $inDur = Read-Host "Duracion de medicion en segundos (20..360)? [default: 30]"
    $DurationS = if ([string]::IsNullOrWhiteSpace($inDur)) { 30 } else { [int]$inDur }
}

$argsList = @(
    "-NoProfile", "-ExecutionPolicy", "Bypass",
    "-File", $BoardsScript,
    "-Action", "Run",
    "-Experiment", "E2",
    "-Variant", $Variant,
    "-Level", "$Vus",
    "-MeasureSeconds", "$DurationS"
)
if ($Vus -gt 400) {
    $argsList += "-AllowHighLoad"
}

Write-Host "`n>>> Ejecutando boards E2 ($Variant) con VUs=$Vus durante ${DurationS}s..." -ForegroundColor Green
Push-Location $RootDir
try {
    & powershell @argsList
} finally {
    Pop-Location
}
