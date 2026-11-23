param(
    [Parameter(Mandatory = $true)][string]$ResultDir,
    [Parameter(Mandatory = $true)][string]$DbUser,
    [Parameter(Mandatory = $true)][string]$DbName,
    [ValidateSet('Both','Resources','Postgres')][string]$Kind = 'Both'
)

$ErrorActionPreference = 'Stop'
$project = 'collaboard-perf'
$sql = @'
SELECT count(*),
       count(*) FILTER (WHERE state = 'active'),
       count(*) FILTER (WHERE state = 'idle'),
       count(*) FILTER (WHERE state LIKE 'idle in transaction%'),
       count(*) FILTER (WHERE state = 'active' AND wait_event IS NOT NULL),
       current_setting('max_connections')
FROM pg_stat_activity
WHERE datname = current_database()
  AND backend_type = 'client backend'
  AND pid <> pg_backend_pid();
'@

function Write-ResourceSample {
    $names = @(docker ps --filter "label=com.docker.compose.project=$project" --format '{{.Names}}')
    if ($LASTEXITCODE -ne 0 -or $names.Count -eq 0) { throw 'No se encontraron contenedores experimentales.' }

    $stats = @(docker stats --no-stream --format '{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}|{{.MemPerc}}' @names 2>$null)
    if ($LASTEXITCODE -ne 0) {
        # A one-off k6 container can exit between docker ps and docker stats.
        $current = @(docker ps --filter "label=com.docker.compose.project=$project" --format '{{.Names}}')
        if ($LASTEXITCODE -ne 0 -or -not (Compare-Object $names $current)) { throw 'Fallo docker stats.' }
        return
    }
    $sampleTime = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $stats | ForEach-Object {
        $name, $cpu, $memory, $percent = $_ -split '\|'
        if ($cpu -ne '--' -and $memory -ne '--') {
            [pscustomobject]@{
                timestamp_ms = $sampleTime
                container = $name
                cpu_pct = $cpu
                memory = ($memory -split ' / ')[0]
                memory_pct = $percent
            }
        }
    } | Export-Csv -Path (Join-Path $ResultDir 'recursos.csv') -NoTypeInformation -Append
}

function Write-PostgresSample {
    $db = @(docker ps --filter "label=com.docker.compose.project=$project" `
        --filter 'label=com.docker.compose.service=board-db' --format '{{.ID}}')
    if ($LASTEXITCODE -ne 0 -or $db.Count -ne 1) { throw 'Se requiere un solo board-db experimental.' }

    $activity = @($sql | docker exec -i $db[0] psql -X -qAt -v ON_ERROR_STOP=1 -U $DbUser -d $DbName -f -)
    if ($LASTEXITCODE -ne 0 -or $activity.Count -ne 1 -or $activity[0] -notmatch '^\d+(\|\d+){5}$') {
        throw 'Fallo la consulta de pg_stat_activity.'
    }
    $total, $active, $idle, $idleInTx, $waiting, $maximum = $activity[0] -split '\|'
    [pscustomobject]@{
        timestamp_ms = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        total = $total
        active = $active
        idle = $idle
        idle_in_transaction = $idleInTx
        active_waiting = $waiting
        max_connections = $maximum
    } | Export-Csv -Path (Join-Path $ResultDir 'postgres.csv') -NoTypeInformation -Append
}

while ($true) {
    $clock = [System.Diagnostics.Stopwatch]::StartNew()
    if ($Kind -ne 'Postgres') { Write-ResourceSample }
    if ($Kind -ne 'Resources') { Write-PostgresSample }
    Start-Sleep -Milliseconds ([Math]::Max(0, 5000 - $clock.ElapsedMilliseconds))
}
