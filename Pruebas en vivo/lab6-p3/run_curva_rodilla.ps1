# Ejecuta la curva completa estilo Laboratorio 6 sobre CollaBoard P3 (HTTPS + S1-S5 + pool v2)
# Niveles por defecto: 1, 10, 50, 100, 150, 200, 300, 500, 1000, 2000 VUs (30s cada uno, sleep(1), timeout 60s)
# Uso:
#   powershell -ExecutionPolicy Bypass -File ".\Pruebas en vivo\lab6-p3\run_curva_rodilla.ps1"
#   powershell -ExecutionPolicy Bypass -File ".\Pruebas en vivo\lab6-p3\run_curva_rodilla.ps1" -Levels 1,50,200,500
param(
    [int[]]$Levels = @(1, 10, 50, 100, 150, 200, 300, 500, 1000, 2000),
    [int]$DurationS = 30,
    [int]$CooldownS = 10,
    [double]$StopOnErrorPct = 0,
    [string]$Project = "collaboard"
)

$ErrorActionPreference = "Stop"
$RootDir = (Resolve-Path "$PSScriptRoot\..\..").Path
$OutDir = Join-Path $PSScriptRoot "resultados"
$CertsDir = Join-Path $PSScriptRoot "certs"
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
New-Item -ItemType Directory -Force -Path $CertsDir | Out-Null

# Verificar que existe la imagen pool-lab6
docker image inspect collaboard-perf_collaboration-api:pool-lab6 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) {
    throw "Falta la imagen collaboard-perf_collaboration-api:pool-lab6. Construyela primero con preparar_variante.py."
}

Write-Host "==================================================================" -ForegroundColor Cyan
Write-Host " CURVA COMPLETA ESTILO LAB 6 SOBRE COLLABOARD P3 (HTTPS + S1-S5)" -ForegroundColor Cyan
Write-Host "==================================================================" -ForegroundColor Cyan
Write-Host "Niveles: $($Levels -join ', ') VUs | Ventana: ${DurationS}s | sleep(1) | timeout: 60s`n" -ForegroundColor Gray

Write-Host "[1/4] Levantando stack P3 con cuotas Lab 6 (1 CPU gateway/collab/board-db) y pool v2..." -ForegroundColor Yellow
docker compose -p $Project `
    -f "$RootDir\docker-compose.yml" `
    -f "$RootDir\notifications-module\compose.gateway.yml" `
    -f "$PSScriptRoot\compose.lab6.yml" `
    up -d --wait

# Extraer CA publica del gateway
$caPath = Join-Path $CertsDir "ca.crt"
docker exec "${Project}-gateway-1" cat /etc/nginx/certs/ca.crt | Set-Content -Path $caPath -Encoding ascii

$NetName = "${Project}_edge"

Write-Host "[2/4] Sembrando usuario de prueba con 10 tableros por HTTPS..." -ForegroundColor Yellow
$seedEmail = "lab6-p3-bench@example.invalid"
$seedPass = "Lab6P3BenchPass2026!"

$seedPy = @"
import json, urllib.request, urllib.error, ssl
ctx = ssl.create_default_context(cafile='/certs/ca.crt')
ctx.check_hostname = False
base = 'https://gateway'
def req(method, path, body=None, token=None):
    data = json.dumps(body).encode() if body is not None else None
    headers = {'Accept': 'application/json'}
    if data is not None: headers['Content-Type'] = 'application/json'
    if token: headers['Authorization'] = f'Bearer {token}'
    r = urllib.request.Request(base + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(r, context=ctx, timeout=15) as resp:
            return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()

st, data = req('POST', '/api/auth/register', {'email': '$seedEmail', 'name': 'Lab6 P3 Bench', 'password': '$seedPass', 'confirm_password': '$seedPass'})
if st not in (200, 201):
    st, data = req('POST', '/api/auth/login', {'email': '$seedEmail', 'password': '$seedPass'})
    assert st == 200, f'Login failed: {st} {data}'
token = data['access_token']
st, boards = req('GET', '/api/boards', token=token)
assert st == 200, f'List failed: {st}'
existing = {b['name'] for b in boards}
for i in range(1, 11):
    name = f'Lab6-P3-Board-{i:02d}'
    if name not in existing:
        st, _ = req('POST', '/api/boards', {'name': name}, token=token)
        assert st in (200, 201), f'Create board failed: {st}'
st, boards = req('GET', '/api/boards', token=token)
print(f'SEED_OK boards={len(boards)} token={token}')
"@

$seedOut = docker run --rm --network $NetName -v "${CertsDir}:/certs:ro" python:3.12-slim python -c $seedPy
$seedLine = ($seedOut | Where-Object { $_ -like "SEED_OK *" } | Select-Object -Last 1)
if (-not $seedLine) { throw "Error en la siembra: $seedOut" }
$token = ($seedLine -split "token=")[1].Trim()
Write-Host "  Usuario listo (10 tableros verificados)." -ForegroundColor Green

function Get-FreshToken {
    $loginPy = @"
import json, urllib.request, ssl
ctx = ssl.create_default_context(cafile='/certs/ca.crt')
ctx.check_hostname = False
data = json.dumps({'email': '$seedEmail', 'password': '$seedPass'}).encode()
r = urllib.request.Request('https://gateway/api/auth/login', data=data, headers={'Content-Type': 'application/json'}, method='POST')
with urllib.request.urlopen(r, context=ctx, timeout=15) as resp:
    print(json.loads(resp.read().decode())['access_token'])
"@
    return (docker run --rm --network $NetName -v "${CertsDir}:/certs:ro" python:3.12-slim python -c $loginPy).Trim()
}

Write-Host "[3/4] Calentamiento comun (10 VUs durante 10 s)..." -ForegroundColor Yellow
docker run --rm --cpus="6.0" --network $NetName `
    -v "${PSScriptRoot}:/k6:ro" `
    -v "${CertsDir}:/certs:ro" `
    -e SSL_CERT_FILE=/certs/ca.crt `
    -e VUS=10 -e DURATION_S=10 -e TOKEN=$token `
    grafana/k6:0.54.0 run --quiet /k6/k6_boards_lab6.js | Out-Null
Start-Sleep -Seconds 5

Write-Host "[4/4] Ejecutando barrido de niveles..." -ForegroundColor Yellow
foreach ($vus in $Levels) {
    $token = Get-FreshToken
    $statsFile = Join-Path $OutDir "stats-${vus}.csv"
    $pgFile = Join-Path $OutDir "pg-${vus}.csv"
    "ts,name,cpu_pct,mem_usage" | Out-File -FilePath $statsFile -Encoding ascii
    "ts,total,active,idle,idle_in_tx" | Out-File -FilePath $pgFile -Encoding ascii

    $jobStats = Start-Job -ScriptBlock {
        param($File, $Proj)
        while ($true) {
            $ts = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
            $lines = docker stats --no-stream --format "{{.Name}},{{.CPUPerc}},{{.MemUsage}}" `
                "${Proj}-gateway-1" "${Proj}-collaboration-api-1" "${Proj}-board-db-1" 2>$null
            foreach ($l in $lines) {
                if ($l) { "$ts,$l" | Out-File -FilePath $File -Append -Encoding ascii }
            }
            Start-Sleep -Seconds 2
        }
    } -ArgumentList $statsFile, $Project

    $jobPg = Start-Job -ScriptBlock {
        param($File, $Proj)
        $q = "SELECT count(*), count(*) FILTER (WHERE state='active'), count(*) FILTER (WHERE state='idle'), count(*) FILTER (WHERE state='idle in transaction') FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend';"
        while ($true) {
            $ts = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
            $row = docker exec "${Proj}-board-db-1" sh -c 'psql -X -qAt -F, -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "$1"' _ $q 2>$null
            if ($row) { "$ts,$row" | Out-File -FilePath $File -Append -Encoding ascii }
            Start-Sleep -Seconds 2
        }
    } -ArgumentList $pgFile, $Project

    Write-Host ("  -> Nivel {0,4} VUs ({1}s)..." -f $vus, $DurationS) -ForegroundColor White
    try {
        docker run --rm --cpus="6.0" --network $NetName `
            -v "${PSScriptRoot}:/k6:ro" `
            -v "${OutDir}:/resultados" `
            -v "${CertsDir}:/certs:ro" `
            -e SSL_CERT_FILE=/certs/ca.crt `
            -e VUS=$vus -e DURATION_S=$DurationS -e TOKEN=$token `
            grafana/k6:0.54.0 run --quiet --summary-export="/resultados/k6-${vus}.json" /k6/k6_boards_lab6.js | Out-Null
    } finally {
        Stop-Job $jobStats, $jobPg -ErrorAction SilentlyContinue
        Remove-Job $jobStats, $jobPg -ErrorAction SilentlyContinue
    }

    # Mostrar resumen rapido del nivel
    $j = Get-Content (Join-Path $OutDir "k6-${vus}.json") -Raw | ConvertFrom-Json
    $avg = $j.metrics.http_req_duration.avg
    $p95 = $j.metrics.http_req_duration.'p(95)'
    $rps = $j.metrics.http_reqs.rate
    $err = $j.metrics.http_req_failed.value * 100
    Write-Host ("     OK: req/s={0:N2} | avg={1:N1} ms | p95={2:N1} ms | err={3:N2}%" -f $rps, $avg, $p95, $err) -ForegroundColor Green

    if ($StopOnErrorPct -gt 0 -and $err -ge $StopOnErrorPct) {
        Write-Host ("  >>> Punto de quiebre alcanzado en {0} VUs (err={1:N2}% >= {2}%). Deteniendo escalada." -f $vus, $err, $StopOnErrorPct) -ForegroundColor Yellow
        break
    }

    if ($vus -ne $Levels[-1]) {
        Start-Sleep -Seconds $CooldownS
    }
}

Write-Host "`nGenerando grafica de la rodilla y tablas..." -ForegroundColor Cyan
$env:MPLCONFIGDIR = "$env:TEMP\mpl"
python "$PSScriptRoot\generar_rodilla_y_tablas.py"
