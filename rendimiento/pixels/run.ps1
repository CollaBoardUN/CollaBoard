# Ejecuta el banco de rendimiento de pixels-api (WS fan-out + costo de segmentación).
# Uso:
#   powershell -ExecutionPolicy Bypass -File rendimiento/pixels/run.ps1 baseline
#   powershell -ExecutionPolicy Bypass -File rendimiento/pixels/run.ps1 variante
#   powershell -ExecutionPolicy Bypass -File rendimiento/pixels/run.ps1 seg-p3
#   powershell -ExecutionPolicy Bypass -File rendimiento/pixels/run.ps1 all
param(
    [Parameter(Position=0)]
    [ValidateSet("baseline", "variante", "seg-p3", "seg-p2", "all")]
    [string]$Modo = "all",
    [string]$Project = "collaboard"
)

$ErrorActionPreference = "Stop"
$RootDir = (Resolve-Path "$PSScriptRoot\..\..").Path
$OutDir = "$PSScriptRoot\resultados"
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
New-Item -ItemType Directory -Force -Path "$PSScriptRoot\certs" | Out-Null

$NetName = "${Project}_edge"

function Start-StatsCapture([string]$Tag) {
    $StatsFile = "$OutDir\stats-$Tag.csv"
    "timestamp,name,cpu_pct,mem_usage,mem_pct" | Out-File -FilePath $StatsFile -Encoding utf8
    $Job = Start-Job -ScriptBlock {
        param($File, $Proj)
        while ($true) {
            $ts = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
            $lines = docker stats --no-stream --format "{{.Name}},{{.CPUPerc}},{{.MemUsage}},{{.MemPerc}}" `
                "${Proj}-gateway-1" "${Proj}-pixels-api-1" "${Proj}-pixels-nosqldb-1" 2>$null
            foreach ($l in $lines) {
                if ($l) { "$ts,$l" | Out-File -FilePath $File -Append -Encoding utf8 }
            }
            Start-Sleep -Seconds 2
        }
    } -ArgumentList $StatsFile, $Project
    return $Job
}

function Invoke-K6Ws([string]$Tag, [int]$Vus, [int]$DurationS = 60, [int]$WarmupS = 10) {
    Write-Host ">>> Ejecutando k6 WS [$Tag] VUs=$Vus (${DurationS}s + ${WarmupS}s warmup)..."
    $SummaryPath = "/resultados/$Tag.json"
    $job = Start-StatsCapture $Tag
    try {
        docker run --rm --cpus="6.0" --network $NetName `
            -v "${PSScriptRoot}\k6:/k6:ro" `
            -v "${OutDir}:/resultados" `
            -v "${PSScriptRoot}\certs:/certs:ro" `
            -e SSL_CERT_FILE=/certs/ca.crt `
            -e VUS=$Vus `
            -e DURATION_S=$DurationS `
            -e WARMUP_S=$WarmupS `
            -e WS_URL="wss://gateway/ws/pixels" `
            grafana/k6 run --summary-export=$SummaryPath /k6/ws_fanout.js
    } finally {
        Stop-Job $job -ErrorAction SilentlyContinue
        Remove-Job $job -ErrorAction SilentlyContinue
    }
    Start-Sleep -Seconds 5
}

function Invoke-K6Stats([string]$Tag, [int]$Rate = 1500, [int]$DurationS = 60, [string]$Url = "https://gateway/api/pixels/stats") {
    Write-Host ">>> Ejecutando k6 HTTP stats [$Tag] rate=$Rate/s (${DurationS}s)..."
    $SummaryPath = "/resultados/$Tag.json"
    $job = Start-StatsCapture $Tag
    try {
        docker run --rm --cpus="6.0" --network $NetName `
            -v "${PSScriptRoot}\k6:/k6:ro" `
            -v "${OutDir}:/resultados" `
            -v "${PSScriptRoot}\certs:/certs:ro" `
            -e SSL_CERT_FILE=/certs/ca.crt `
            -e RATE=$Rate `
            -e DURATION_S=$DurationS `
            -e STATS_URL=$Url `
            grafana/k6 run --summary-export=$SummaryPath /k6/segmentation_overhead.js
    } finally {
        Stop-Job $job -ErrorAction SilentlyContinue
        Remove-Job $job -ErrorAction SilentlyContinue
    }
    Start-Sleep -Seconds 3
}

function Bring-Up([int]$BatchMs) {
    $env:PIXELS_BATCH_INTERVAL_MS = "$BatchMs"
    Write-Host ">>> Levantando stack con PIXELS_BATCH_INTERVAL_MS=$BatchMs..."
    docker compose -p $Project -f "$RootDir\docker-compose.yml" `
        -f "$RootDir\notifications-module\compose.gateway.yml" `
        -f "$PSScriptRoot\compose.override.yml" up -d --build --wait
}

if ($Modo -in @("baseline", "all")) {
    Bring-Up 0
    Invoke-K6Ws "A-ws-100-r1" 100
    Invoke-K6Ws "A-ws-500-r1" 500
    Invoke-K6Ws "A-ws-500-r2" 500
    Invoke-K6Ws "A-ws-500-r3" 500
    Invoke-K6Ws "A-ws-1000-r1" 1000
    Invoke-K6Ws "A-ws-1000-r2" 1000
    Invoke-K6Ws "A-ws-1000-r3" 1000
    Invoke-K6Ws "A-ws-2000-r1" 2000
}

if ($Modo -in @("variante", "all")) {
    Bring-Up 50
    Invoke-K6Ws "B-ws-100-r1" 100
    Invoke-K6Ws "B-ws-500-r1" 500
    Invoke-K6Ws "B-ws-500-r2" 500
    Invoke-K6Ws "B-ws-500-r3" 500
    Invoke-K6Ws "B-ws-1000-r1" 1000
    Invoke-K6Ws "B-ws-1000-r2" 1000
    Invoke-K6Ws "B-ws-1000-r3" 1000
    Invoke-K6Ws "B-ws-2000-r1" 2000
}

if ($Modo -in @("seg-p3", "all")) {
    Bring-Up 50
    Invoke-K6Stats "seg-p3-1500-r1" 1500
    Invoke-K6Stats "seg-p3-1500-r2" 1500
    Invoke-K6Stats "seg-p3-1500-r3" 1500
}

if ($Modo -eq "seg-p2") {
    Invoke-K6Stats "seg-p2-1500-r1" 1500
    Invoke-K6Stats "seg-p2-1500-r2" 1500
    Invoke-K6Stats "seg-p2-1500-r3" 1500
}

