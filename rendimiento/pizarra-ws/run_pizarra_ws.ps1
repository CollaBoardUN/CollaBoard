# Estudio riguroso de concurrencia WebSocket de pizarra-api (/ws/boards/{id}?token=JWT)
# - 20 usuarios editores reales distintos (ejercitan PEP + Cache-Aside 2s en S5)
# - Operaciones reales `ops` (add idempotente) con `ack` correlacionado por `ref` (RTT exacto sin truncamiento) + `cursor`
# - Calentamiento separado (10 s excluidos) + 30 s de medicion estable
# - Barrido completo en 1 sala (1..200 VUs con refinamiento cada 10 VUs en 100..150) + control multi-sala (15 salas x 10 VUs = 150 VUs)
param(
    [int[]]$Levels = @(1, 10, 25, 50, 75, 100, 110, 120, 130, 140, 150, 200),
    [int]$WarmupS = 10,
    [int]$DurationS = 30,
    [int]$CooldownS = 8,
    [int]$MultiRoomVus = 150,
    [int]$MultiRoomBoards = 15,
    [switch]$KeepExisting,
    [string]$Project = "collaboard"
)

$ErrorActionPreference = "Stop"
$RootDir = (Resolve-Path "$PSScriptRoot\..\..").Path
$OutDir = Join-Path $PSScriptRoot "resultados"
if (-not $KeepExisting -and (Test-Path $OutDir)) { Remove-Item -Recurse -Force $OutDir }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

Write-Host "========================================================================" -ForegroundColor Cyan
Write-Host " ESTUDIO RIGUROSO DE CONCURRENCIA WEBSOCKET - PIZARRA-API (k6)" -ForegroundColor Cyan
Write-Host "========================================================================" -ForegroundColor Cyan
Write-Host "Niveles 1 sala: $($Levels -join ', ') VUs | Warmup: ${WarmupS}s + Medicion: ${DurationS}s" -ForegroundColor Gray
Write-Host "Control multi-sala: $MultiRoomVus VUs en $MultiRoomBoards salas ($([int]($MultiRoomVus/$MultiRoomBoards)) VUs/sala)`n" -ForegroundColor Gray

Write-Host "[1/4] Levantando stack P3 con 1 CPU en pizarra-api/gateway y LIMIT_CONN_WS_PER_IP=10000..." -ForegroundColor Yellow
docker compose -p $Project `
    -f "$RootDir\docker-compose.yml" `
    -f "$RootDir\notifications-module\compose.gateway.yml" `
    -f "$PSScriptRoot\compose.pizarra.yml" `
    up -d --wait

$NetName = "${Project}_edge"

Write-Host "[2/4] Sembrando 20 usuarios editores reales y $MultiRoomBoards tableros con invitaciones..." -ForegroundColor Yellow
$seedPy = @'
import json, urllib.request, urllib.error, ssl
ctx = ssl._create_unverified_context()
base = 'https://gateway'

def req(method, path, body=None, token=None):
    data = json.dumps(body).encode() if body is not None else None
    headers = {'Accept': 'application/json'}
    if data is not None:
        headers['Content-Type'] = 'application/json'
    if token:
        headers['Authorization'] = 'Bearer ' + token
    r = urllib.request.Request(base + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(r, context=ctx, timeout=20) as resp:
            raw = resp.read().decode()
            return resp.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()

tokens = []
for i in range(1, 21):
    email = f'pizarra-ws-u{i:02d}@example.invalid'
    pwd = f'PizarraWsUser{i:02d}!2026'
    st, data = req('POST', '/api/auth/register', {'email': email, 'name': f'WS Editor {i:02d}', 'password': pwd, 'confirm_password': pwd})
    if st not in (200, 201):
        st, data = req('POST', '/api/auth/login', {'email': email, 'password': pwd})
        assert st == 200, f'Login user {i} failed: {st} {data}'
    tokens.append(data['access_token'])

owner_tok = tokens[0]
st, existing_boards = req('GET', '/api/boards', token=owner_tok)
assert st == 200
by_name = {b['name']: b['id'] for b in existing_boards}

board_ids = []
for b_idx in range(1, 16):
    bname = f'Pizarra-WS-Room-{b_idx:02d}'
    bid = by_name.get(bname)
    if not bid:
        st, created = req('POST', '/api/boards', {'name': bname}, token=owner_tok)
        assert st in (200, 201), f'Create board {bname} failed: {st} {created}'
        bid = created['id']
    board_ids.append(bid)
    # Crear link de invitacion editor y unir a los otros 19 usuarios
    st, inv = req('POST', f'/api/boards/{bid}/invite', {'role': 'editor'}, token=owner_tok)
    assert st in (200, 201), f'Invite failed: {st} {inv}'
    inv_tok = inv['token']
    for u_tok in tokens[1:]:
        st, _ = req('POST', f'/api/invites/{inv_tok}/accept', {}, token=u_tok)
        assert st in (200, 201), f'Accept invite failed: {st}'

print('SEED_JSON=' + json.dumps({'boards': board_ids, 'tokens': tokens}))
'@

$seedFile = Join-Path $OutDir "seed_pizarra.py"
[IO.File]::WriteAllText($seedFile, $seedPy, [Text.UTF8Encoding]::new($false))

function Get-SeedData {
    $out = docker run --rm --network $NetName -v "${OutDir}:/seed:ro" python:3.12-slim python /seed/seed_pizarra.py
    $line = ($out | Where-Object { $_ -like "SEED_JSON=*" } | Select-Object -Last 1)
    if (-not $line) { throw "Error en la siembra: $out" }
    return ($line.Substring("SEED_JSON=".Length)) | ConvertFrom-Json
}

$seedData = Get-SeedData
$allBoards = @($seedData.boards)
$allTokens = @($seedData.tokens)
$tokensCsv = $allTokens -join ","
$singleBoardId = $allBoards[0]
$multiBoardsCsv = ($allBoards | Select-Object -First $MultiRoomBoards) -join ","
Write-Host "  Listo: $($allTokens.Count) usuarios editores unidos a $($allBoards.Count) tableros (tokens frescos)." -ForegroundColor Green

function Invoke-WsRun([string]$Tag, [int]$Vus, [string]$BoardIdsCsv) {
    $statsFile = Join-Path $OutDir "stats-${Tag}.csv"
    "ts,name,cpu_pct,mem_usage" | Out-File -FilePath $statsFile -Encoding ascii

    $jobStats = Start-Job -ScriptBlock {
        param($File, $Proj)
        while ($true) {
            $ts = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
            $lines = docker stats --no-stream --format "{{.Name}},{{.CPUPerc}},{{.MemUsage}}" `
                "${Proj}-gateway-1" "${Proj}-pizarra-api-1" "${Proj}-collaboration-api-1" "${Proj}-canvas-db-1" 2>$null
            foreach ($l in $lines) {
                if ($l) { "$ts,$l" | Out-File -FilePath $File -Append -Encoding ascii }
            }
            Start-Sleep -Seconds 2
        }
    } -ArgumentList $statsFile, $Project

    Write-Host ("  -> [{0}] VUs={1,3} ({2}s warmup + {3}s medicion)..." -f $Tag, $Vus, $WarmupS, $DurationS) -ForegroundColor White
    try {
        docker run --rm --cpus="6.0" --network $NetName `
            -v "${PSScriptRoot}:/k6:ro" `
            -v "${OutDir}:/resultados" `
            -e VUS=$Vus -e WARMUP_S=$WarmupS -e DURATION_S=$DurationS `
            -e BOARD_IDS=$BoardIdsCsv -e TOKENS=$tokensCsv `
            grafana/k6:0.54.0 run --quiet --summary-export="/resultados/k6-${Tag}.json" /k6/k6_pizarra_ws.js | Out-Null
    } finally {
        Stop-Job $jobStats -ErrorAction SilentlyContinue
        Remove-Job $jobStats -ErrorAction SilentlyContinue
    }

    $j = Get-Content (Join-Path $OutDir "k6-${Tag}.json") -Raw | ConvertFrom-Json
    $avg = if ($j.metrics.ws_ack_rtt_ms) { $j.metrics.ws_ack_rtt_ms.avg } else { 0 }
    $p95 = if ($j.metrics.ws_ack_rtt_ms) { $j.metrics.ws_ack_rtt_ms.'p(95)' } else { 0 }
    $max = if ($j.metrics.ws_ack_rtt_ms) { $j.metrics.ws_ack_rtt_ms.max } else { 0 }
    $msgs = if ($j.metrics.ws_messages_received) { $j.metrics.ws_messages_received.count / $DurationS } else { 0 }
    $acks = if ($j.metrics.ws_acks_received) { $j.metrics.ws_acks_received.count } else { 0 }
    $sent = if ($j.metrics.ws_ops_sent) { $j.metrics.ws_ops_sent.count } else { 0 }
    $err = if ($j.metrics.ws_errors) { $j.metrics.ws_errors.value * 100 } else { 0 }
    Write-Host ("     OK: msg/s={0:N1} | ops/ack={1}/{2} | RTT avg={3:N1}ms p95={4:N1}ms max={5:N1}ms | err={6:N2}%" -f $msgs, $sent, $acks, $avg, $p95, $max, $err) -ForegroundColor Green
    return $err
}

Write-Host "`n[3/4] Escenario A - Una sola sala compartida (fan-out O(N^2))..." -ForegroundColor Yellow
$highErrCount = 0
foreach ($vus in $Levels) {
    $err = Invoke-WsRun "single-$vus" $vus $singleBoardId
    if ($err -ge 25) { $highErrCount += 1 }
    if ($highErrCount -ge 2 -and $vus -ge 150) {
        Write-Host "  >>> Punto de quiebre confirmado en 2 niveles consecutivos con >=25% error. Deteniendo escalada." -ForegroundColor Yellow
        break
    }
    Start-Sleep -Seconds $CooldownS
}

Write-Host "`n[4/4] Escenario B - Control multi-sala ($MultiRoomVus VUs en $MultiRoomBoards salas de $([int]($MultiRoomVus/$MultiRoomBoards)) VUs)..." -ForegroundColor Yellow
Invoke-WsRun "multi-$MultiRoomVus" $MultiRoomVus $multiBoardsCsv | Out-Null

Write-Host "`nGenerando graficas estilo Lab 6, informe completo y ZIP..." -ForegroundColor Cyan
$env:MPLCONFIGDIR = "$env:TEMP\mpl"
python "$PSScriptRoot\generar_pizarra_ws.py"
