function Get-ContainerId($Project, $Service) {
    $ids = @(docker ps -aq --filter "label=com.docker.compose.project=$Project" `
        --filter "label=com.docker.compose.service=$Service")
    if ($LASTEXITCODE -ne 0 -or $ids.Count -ne 1) { throw "No se encontro un contenedor unico para $Service." }
    return $ids[0]
}

function Get-BoardsLogEvent($Service, $Line, $RunTag, [DateTimeOffset]$WindowEnd) {
    if ($Line -notmatch '^(?<utc>\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z)\s+(?<message>.+)$') { return }
    $stamp = $Matches.utc
    $message = $Matches.message
    $instant = [DateTimeOffset]::Parse(($stamp -replace '(\.\d{7})\d+(?=Z)', '$1'))
    $event = [ordered]@{
        timestamp_utc = $stamp
        phase = if ($instant -lt $WindowEnd) { 'measurement' } else { 'after_window' }
        service = $Service
        event = ''
        request_id = ''
        status = ''
        upstream_status = ''
        duration_ms = ''
        pool_size = ''
        pool_overflow = ''
        pool_timeout_s = ''
    }
    $rid = 'boards-' + [regex]::Escape($RunTag) + '-\d+'
    if ($Service -eq 'gateway') {
        if ($message -match ('"GET /(?:api/)?boards" (?<status>\d{3}) rid=(?<rid>' + $rid +
                ') up=.+? us=(?<up>(?:\d{3}(?:\s*[:,]\s*\d{3})*|-)) rt=(?<sec>\d+(?:\.\d+)?)\s*$')) {
            $event.event = 'access'
            $event.request_id = $Matches.rid
            $event.status = $Matches.status
            $event.upstream_status = $Matches.up
            $event.duration_ms = ([double]::Parse($Matches.sec, [Globalization.CultureInfo]::InvariantCulture) *
                1000).ToString('0.###', [Globalization.CultureInfo]::InvariantCulture)
        } elseif ($message -match 'request: "GET /(?:api/)?boards HTTP/[\d.]+"' -and
                  $message -match '(?<kind>limiting requests|limiting connections|upstream timed out|upstream prematurely closed connection|connect\(\) failed)') {
            $event.event = @{
                'limiting requests' = 'rate_limit'
                'limiting connections' = 'connection_limit'
                'upstream timed out' = 'upstream_timeout'
                'upstream prematurely closed connection' = 'upstream_closed'
                'connect() failed' = 'upstream_connect_error'
            }[$Matches.kind]
        }
    } else {
        if ($message -match ('\bhttp request_id=(?<rid>' + $rid +
                ') method=GET path=/boards status=(?<status>\d{3}) ms=(?<ms>\d+(?:\.\d+)?)\s*$')) {
            $event.event = 'request'
            $event.request_id = $Matches.rid
            $event.status = $Matches.status
            $event.duration_ms = $Matches.ms
        } elseif ($message -match 'QueuePool limit of size (?<size>\d+) overflow (?<overflow>\d+) reached, connection timed out, timeout (?<timeout>\d+(?:\.\d+)?)') {
            $event.event = 'queuepool_timeout'
            $event.pool_size = $Matches.size
            $event.pool_overflow = $Matches.overflow
            $event.pool_timeout_s = $Matches.timeout
        }
    }
    if ($event.event) { [pscustomobject]$event }
}

function Export-BoardsLogs($Containers, $ResultDir, $RunTag, [DateTimeOffset]$Start,
    [DateTimeOffset]$WindowEnd, [DateTimeOffset]$Until) {
    $capture = [ordered]@{}
    foreach ($service in $Containers.Keys) {
        $count = 0
        # Docker logs forwards container stderr. Only parsed, allow-listed fields reach the CSV.
        $ErrorActionPreference = 'Continue'
        $file = Join-Path $ResultDir "$service.csv"
        docker logs --timestamps --since $Start.ToString('o') --until $Until.ToString('o') $Containers[$service] 2>&1 |
            ForEach-Object { Get-BoardsLogEvent $service ([string]$_) $RunTag $WindowEnd } |
            ForEach-Object { $count++; $_ } |
            Export-Csv -Path $file -NoTypeInformation -Encoding UTF8
        $capture[$service] = @{ exit_code = $LASTEXITCODE; events = $count }
        if ($LASTEXITCODE -ne 0) { Write-Warning "No se pudo completar la captura de $service." }
    }
    return $capture
}

function Get-EffectiveGatewayPolicy($Container) {
    $ErrorActionPreference = 'Continue'
    $directives = @(docker exec $Container nginx -T 2>$null | ForEach-Object {
        if ($_ -match '^\s*(?<directive>limit_(?:req_zone\s+\$rl_key\s+zone=(?:api|auth):\d+[kmg]\s+rate=\d+r/[sm]|req\s+zone=(?:api|auth)\s+burst=\d+\s+nodelay|conn\s+conn\s+\d+|(?:req|conn)_status\s+429));\s*$') {
            $Matches.directive -replace '\s+', ' '
        }
    } | Sort-Object -Unique)
    if ($LASTEXITCODE -ne 0 -or $directives.Count -lt 7) {
        throw 'No se pudo verificar el conjunto de directivas de tasa y conexiones.'
    }
    return $directives
}
