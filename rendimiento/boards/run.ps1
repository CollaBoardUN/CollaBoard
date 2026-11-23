# Requires Windows PowerShell 5.1+ and Docker Compose v2.2.3.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateSet('Config','Configure','Prepare','Pilot','Run')][string]$Action,
    [ValidateSet('E1','E2')][string]$Experiment = 'E2',
    [ValidateSet('Original','Pool')][string]$Variant = 'Original',
    [ValidateRange(1,2000)][int]$Level,
    [ValidateRange(1,99)][int]$Repetition = 1,
    [ValidateRange(10,120)][int]$WarmupSeconds = 30,
    [ValidateRange(20,360)][int]$MeasureSeconds = 90,
    [ValidateSet('Sweep','Refinement')][string]$Phase = 'Sweep',
    [switch]$AllowHighLoad
)

$ErrorActionPreference = 'Stop'
$project = 'collaboard-perf'
$root = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$local = Join-Path $PSScriptRoot '.local'
$utf8 = New-Object System.Text.UTF8Encoding($false)
. (Join-Path $PSScriptRoot 'capturar-logs.ps1')
$files = @(
    (Join-Path $root 'docker-compose.yml'),
    (Join-Path $root 'notifications-module/compose.gateway.yml'),
    (Join-Path $PSScriptRoot 'compose.override.yml')
)
if ($Action -eq 'Run') {
    if (-not $PSBoundParameters.ContainsKey('Level')) { throw 'Run requiere -Level.' }
    if ($Experiment -eq 'E1' -and $Level -gt 500) { throw 'E1 admite hasta 500 req/s.' }
    if ($Experiment -eq 'E2' -and $Level -gt 400 -and -not $AllowHighLoad) {
        throw 'Para E2 por encima de 400 VUs, valide el nivel anterior antes de usar -AllowHighLoad.'
    }
}
if ($Variant -eq 'Pool' -and ($Experiment -ne 'E2' -or $Action -notin 'Config','Configure','Run')) {
    throw 'La variante de pool se reserva para Config, Configure y Run de E2.'
}
if ($Action -eq 'Pilot') {
    $Experiment = 'E2'
    $Level = 1
    $WarmupSeconds = 10
    $MeasureSeconds = 20
}

New-Item -ItemType Directory -Path $local -Force | Out-Null
$lock = [IO.File]::Open((Join-Path $local 'run.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
$tempId = [Guid]::NewGuid().ToString('N')
$modelPath = Join-Path $local 'compose.json'
$envPath = Join-Path $local 'perf.env'
$ownerPath = Join-Path $local 'owner-id'
$ownerLabel = 'edu.unal.collaboard.boards-perf'
$savedEnvironment = @{}
$jobs = @()
if ($Action -eq 'Config') {
    $envPath = Join-Path $local "config-$tempId.env"
    $modelPath = Join-Path $local "config-$tempId.json"
}

function Read-Model($composeArgs) {
    $rendered = docker compose @composeArgs config --format json 2>$null | Out-String
    if ($LASTEXITCODE -ne 0) {
        throw 'Compose config fallo. Revise la version de Compose y los archivos de entrada experimentales.'
    }
    return ConvertFrom-Json -InputObject $rendered
}

function Get-ExistingResources($owner) {
    $checks = @(
        @{ Args = @('ps','-a'); Format = '{{.Names}}' },
        @{ Args = @('network','ls'); Format = '{{.Name}}' },
        @{ Args = @('volume','ls'); Format = '{{.Name}}' }
    )
    foreach ($check in $checks) {
        $listArgs = $check.Args
        $all = @(docker @listArgs --format $check.Format)
        if ($LASTEXITCODE -ne 0) { throw 'No se pudo inventariar Docker antes del arranque.' }
        $labeled = @(docker @listArgs --filter "label=com.docker.compose.project=$project" --format $check.Format)
        if ($LASTEXITCODE -ne 0) { throw 'No se pudieron consultar las etiquetas del proyecto experimental.' }
        $existing = @($labeled + @($all | Where-Object { $_ -match '^collaboard-perf(?:[-_]|$)' }) |
            Sort-Object -Unique)
        if ($existing.Count -eq 0) { continue }
        $owned = @()
        if ($owner) {
            $owned = @(docker @listArgs --filter "label=$ownerLabel=$owner" --format $check.Format)
            if ($LASTEXITCODE -ne 0) { throw 'No se pudo verificar la procedencia de los recursos.' }
        }
        $unknown = @($existing | Where-Object { $_ -notin $owned -or $_ -notin $labeled })
        if ($unknown.Count) {
            throw "Recursos experimentales de procedencia desconocida: $($unknown -join ', ')."
        }
        $existing
    }
}

function Set-OwnerLabels($model, $owner) {
    foreach ($group in @($model.services, $model.networks, $model.volumes)) {
        foreach ($resource in $group.PSObject.Properties.Value) {
            if (-not $resource.labels) { $resource | Add-Member NoteProperty labels ([pscustomobject]@{}) -Force }
            $resource.labels | Add-Member NoteProperty $ownerLabel $owner -Force
        }
    }
}

function Wait-ProjectHealth($model) {
    $services = @($model.services.PSObject.Properties | Where-Object { -not $_.Value.profiles } |
        Select-Object -ExpandProperty Name)
    $deadline = [DateTime]::UtcNow.AddMinutes(3)
    do {
        $pending = @()
        foreach ($service in $services) {
            $name = "$project-$service-1"
            $state = docker inspect --format '{{json .State}}' $name | ConvertFrom-Json
            if ($LASTEXITCODE -ne 0) { throw "Falta el contenedor experimental $name." }
            if ($state.Status -in @('restarting','dead','exited') -or $state.Health.Status -eq 'unhealthy') {
                throw "Servicio experimental $service en estado $($state.Status) / $($state.Health.Status)."
            }
            if ($state.Status -ne 'running' -or ($state.Health -and $state.Health.Status -ne 'healthy')) {
                $pending += $service
            }
        }
        if (-not $pending.Count) { return }
        Start-Sleep -Seconds 2
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "Tiempo de espera agotado para: $($pending -join ', ')."
}

function Get-EffectiveLimits {
    $memory = @{ gateway = 512MB; 'collaboration-api' = 512MB; 'board-db' = 1GB }
    $limits = [ordered]@{}
    foreach ($service in @('gateway','collaboration-api','board-db')) {
        $limit = docker inspect --format '{{.HostConfig.CpuPeriod}}|{{.HostConfig.CpuQuota}}|{{.HostConfig.Memory}}' "$project-$service-1"
        if ($LASTEXITCODE -ne 0 -or $limit -ne "100000|100000|$($memory[$service])") {
            throw "Cuota efectiva inesperada para $service."
        }
        $limits[$service] = @{ cpu_count = 1; memory_bytes = $memory[$service] }
    }
    return $limits
}

function Get-MainProjectState {
    $ids = @(docker ps -aq --filter 'label=com.docker.compose.project=collaboard')
    if ($LASTEXITCODE -ne 0) { throw 'No se pudo observar el proyecto principal.' }
    if (-not $ids.Count) { return }
    docker inspect --format '{{.Id}} {{.State.Status}} {{.State.StartedAt}} {{.RestartCount}}' @ids | Sort-Object
    if ($LASTEXITCODE -ne 0) { throw 'No se pudo observar el estado de los contenedores principales.' }
}

function Get-PhysicalHost {
    $computer = Get-CimInstance Win32_ComputerSystem -ErrorAction SilentlyContinue
    $processor = Get-CimInstance Win32_Processor -ErrorAction SilentlyContinue
    $os = Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue
    $model = @(Get-ItemProperty 'HKLM:\HARDWARE\DESCRIPTION\System\CentralProcessor\0' -ErrorAction SilentlyContinue)
    return @{
        cpu = if ($processor) { ($processor.Name | Sort-Object -Unique) -join ', ' } else { $model.ProcessorNameString }
        memory_bytes = $computer.TotalPhysicalMemory
        os = if ($os) { "$($os.Caption) (build $($os.BuildNumber))" } else { [Environment]::OSVersion.VersionString }
    }
}

function Assert-Isolated($model, $owner) {
    foreach ($resources in @($model.networks, $model.volumes)) {
        foreach ($property in $resources.PSObject.Properties) {
            if ($property.Value.external -or $property.Value.name -ne "${project}_$($property.Name)" -or
                $property.Value.labels.$ownerLabel -ne $owner) {
                throw "Recurso no aislado: $($property.Name)"
            }
        }
    }
    foreach ($service in $model.services.PSObject.Properties) {
        $config = $service.Value
        if ($config.labels.$ownerLabel -ne $owner -or $config.ports -or $config.container_name -or $config.network_mode -or
            $config.links -or $config.external_links -or $config.volumes_from) {
            throw "Conexion o nombre no aislado: $($service.Name)"
        }
        foreach ($mount in $config.volumes) {
            if ($mount.type -eq 'bind') {
                $allowed = @(
                    (Join-Path $root 'mongo/init'),
                    (Join-Path $PSScriptRoot 'k6'),
                    (Join-Path $local 'ca.crt')
                ) | ForEach-Object { [IO.Path]::GetFullPath($_) }
                if (-not $mount.read_only -or [IO.Path]::GetFullPath($mount.source) -notin $allowed) {
                    throw "Montaje inesperado: $($service.Name)"
                }
            }
        }
    }
    $gatewayMounts = @($model.services.gateway.volumes | Where-Object { $_.target -eq '/etc/nginx/certs' })
    if ($gatewayMounts.Count -ne 1 -or $gatewayMounts[0].type -ne 'volume' -or
        $gatewayMounts[0].source -ne 'boards_tls') {
        throw 'La CA tiene que pertenecer al volumen experimental.'
    }
    $k6Networks = @($model.services.'k6-boards'.networks.PSObject.Properties.Name)
    if ($k6Networks.Count -ne 1 -or $k6Networks[0] -ne 'edge' -or
        -not $model.networks.'net-board'.internal -or -not $model.networks.app.internal) {
        throw 'Segmentacion experimental inesperada.'
    }
    $gatewayEnv = $model.services.gateway.environment
    if ($gatewayEnv.RATE_LIMIT_API -ne $env:BOARDS_API_RATE -or
        $gatewayEnv.RATE_LIMIT_API_BURST -ne $env:BOARDS_API_BURST -or
        $gatewayEnv.LIMIT_CONN_PER_IP -ne $env:BOARDS_CONNECTIONS -or
        $gatewayEnv.RATE_LIMIT_AUTH -ne '5r/s' -or $gatewayEnv.RATE_LIMIT_AUTH_BURST -ne '10' -or
        $gatewayEnv.TLS_EXTRA_SAN -ne 'DNS:gateway' -or $gatewayEnv.GATEWAY_TLS_PORT -ne '443' -or
        $model.services.'web-ssr'.environment.SESSION_COOKIE_SECURE -ne 'true' -or
        $model.services.'auth-api'.environment.FRONTEND_URL -ne 'https://gateway' -or
        $model.services.'collaboration-api'.environment.AUTH_DEV_MODE -ne 'false') {
        throw 'Perfil de seguridad experimental inesperado.'
    }
}

try {
    # Compose gives caller environment precedence over --env-file.
    $variables = foreach ($file in $files) {
        foreach ($match in [regex]::Matches([IO.File]::ReadAllText($file), '(?<!\$)\$\{([A-Z][A-Z0-9_]*)')) {
            $match.Groups[1].Value
        }
    }
    $variables += @(Get-ChildItem Env:COMPOSE_* | Select-Object -ExpandProperty Name)
    foreach ($name in ($variables | Sort-Object -Unique)) {
        $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
        [Environment]::SetEnvironmentVariable($name, $null, 'Process')
    }
    if ($Experiment -eq 'E1') {
        $env:BOARDS_API_RATE = '30r/s'
        $env:BOARDS_API_BURST = '60'
        $env:BOARDS_CONNECTIONS = '60'
    } else {
        $env:BOARDS_API_RATE = '100000r/s'
        $env:BOARDS_API_BURST = '100000'
        $env:BOARDS_CONNECTIONS = '10000'
    }

    $owner = $tempId
    if ($Action -ne 'Config') {
        $owner = $null
        if (Test-Path -LiteralPath $ownerPath) {
            $owner = [IO.File]::ReadAllText($ownerPath).Trim()
            if ($owner -notmatch '^[0-9a-f]{32}$') { throw 'Identificador local de procedencia ilegible.' }
        }
        $existing = @(Get-ExistingResources $owner)
        if ($existing.Count -and -not (Test-Path -LiteralPath $envPath)) {
            throw 'Falta el archivo de entorno asociado a los recursos experimentales existentes.'
        }
        if (-not $owner) {
            $owner = $tempId
            [IO.File]::WriteAllText($ownerPath, $owner, $utf8)
        }
    }

    if (-not (Test-Path -LiteralPath $envPath)) {
        if ($Action -in 'Run','Configure') { throw 'Ejecute Prepare antes de usar imagenes existentes.' }
        $example = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'perf.env.example'))
        $generated = [regex]::Replace($example, '__GENERATE__', { [Guid]::NewGuid().ToString('N') })
        [IO.File]::WriteAllText($envPath, $generated, $utf8)
    }

    $common = @('--env-file', $envPath, '--project-directory', $root, '-p', $project)
    $profile = @('--profile', 'boards-bench')
    $sources = $common + $profile
    foreach ($file in $files) { $sources += @('-f', $file) }
    $model = Read-Model $sources

    # v2.2.3 merges ports and has no !reset. Remove the known published ports
    # explicitly, then validate the exact model that may be used for a launch.
    $model.services.gateway.PSObject.Properties.Remove('ports')
    # v2.2.3 removes build definitions for --no-build before inferring image names.
    foreach ($service in $model.services.PSObject.Properties) {
        if ($service.Value.build -and -not $service.Value.image) {
            $service.Value | Add-Member NoteProperty image "${project}_$($service.Name)" -Force
        }
    }
    if ($Variant -eq 'Pool') {
        $variantImage = "${project}_collaboration-api:pool-lab6"
        if ($Action -ne 'Config') {
            docker image inspect --format '{{.Id}}' $variantImage 2>$null | Out-Null
            if ($LASTEXITCODE -ne 0) { throw 'Falta la imagen experimental de pool.' }
        }
        $model.services.'collaboration-api'.image = $variantImage
        $model.services.'collaboration-api'.PSObject.Properties.Remove('build')
    }
    Set-OwnerLabels $model $owner
    [IO.File]::WriteAllText($modelPath, ($model | ConvertTo-Json -Depth 50), $utf8)
    $compose = $common + @('-f', $modelPath)
    $effective = Read-Model ($compose + $profile)
    Assert-Isolated $effective $owner
    if ($Action -eq 'Config') {
        Write-Output "Compose valido para $project ($Experiment), sin puertos publicados."
        return
    }

    $build = if ($Action -in 'Run','Configure') { '--no-build' } else { '--build' }
    docker compose @compose up -d $build
    if ($LASTEXITCODE -ne 0) { throw 'No se pudo iniciar collaboard-perf.' }
    Wait-ProjectHealth $effective
    $limits = Get-EffectiveLimits
    $ca = docker compose @compose exec -T gateway cat /etc/nginx/certs/ca.crt | Out-String
    if ($LASTEXITCODE -ne 0 -or $ca.Trim() -notmatch '(?s)\A-----BEGIN CERTIFICATE-----\s+[A-Za-z0-9+/=\s]+-----END CERTIFICATE-----\z') {
        throw 'Falta un certificado CA valido en el gateway experimental.'
    }
    [IO.File]::WriteAllText((Join-Path $local 'ca.crt'), $ca.Trim() + "`n", $utf8)
    if ($Action -eq 'Configure') {
        Get-EffectiveGatewayPolicy (Get-ContainerId $project 'gateway')
        return
    }

    $k6 = @('run', '--rm', '--no-deps', '-T')
    if ($Action -in @('Prepare','Pilot')) {
        docker compose @compose @k6 k6-boards run --quiet /bench/seed.js
        if ($LASTEXITCODE -ne 0) { throw 'Fallo la siembra sintetica.' }
    }
    if ($Action -eq 'Prepare') { return }

    $runId = '{0}-{1}-r{2}-{3}' -f $Experiment, $Level, $Repetition, $tempId.Substring(0, 12)
    $result = Join-Path (Join-Path $PSScriptRoot 'resultados') $runId
    New-Item -ItemType Directory -Path $result -Force | Out-Null
    $db = $effective.services.'board-db'.environment
    $revision = git -c "safe.directory=$($root.Replace('\','/'))" -C $root rev-parse HEAD
    if ($LASTEXITCODE -ne 0) { throw 'No se pudo identificar la revision Git.' }
    $engine = docker version --format '{{.Server.Version}}'
    if ($LASTEXITCODE -ne 0) { throw 'No se pudo identificar Docker Engine.' }
    $composeVersion = docker compose version --short
    if ($LASTEXITCODE -ne 0) { throw 'No se pudo identificar Docker Compose.' }

    $hostResources = docker info --format '{{.NCPU}} CPU / {{.MemTotal}} bytes / {{.Architecture}}'
    if ($LASTEXITCODE -ne 0) { throw 'No se pudieron identificar los recursos de Docker.' }
    $cgroup = docker info --format '{{.CgroupVersion}}'
    if ($LASTEXITCODE -ne 0) { throw 'No se pudo identificar la version de cgroup.' }
    $logContainers = [ordered]@{}
    foreach ($service in @('gateway','collaboration-api')) {
        $logContainers[$service] = Get-ContainerId $project $service
    }
    $existingIds = @(docker ps -q --filter "label=com.docker.compose.project=$project")
    if ($LASTEXITCODE -ne 0 -or -not $existingIds.Count) { throw 'No se encontro el despliegue experimental.' }
    $images = @(docker inspect --format '{{.Name}} {{.Image}}' @existingIds | Sort-Object)
    if ($LASTEXITCODE -ne 0) { throw 'No se pudieron identificar las imagenes del despliegue experimental.' }
    $before = @(Get-MainProjectState)
    $code = foreach ($name in @('run.ps1','capturar.ps1','capturar-logs.ps1','compose.override.yml',
            'k6/boards_list.js','k6/catalog.js','k6/seed.js')) {
        (Get-FileHash -Algorithm SHA256 (Join-Path $PSScriptRoot $name)).Hash
    }
    $runStarted = [DateTimeOffset]::UtcNow
    $metadata = [ordered]@{
        project = $project; action = $Action; variant = $Variant; repetition = $Repetition; revision = $revision
        engine = $engine; compose = $composeVersion; docker_host = $hostResources
        cgroup_version = $cgroup; physical_host = Get-PhysicalHost
        phase = if ($Action -eq 'Pilot') { 'Pilot' } else { $Phase }
        run_started_at_utc = $runStarted.ToString('o')
        resource_limits = $limits; images = $images; bench_code_sha256 = $code
        k6_image = $effective.services.'k6-boards'.image
        api_rate = $env:BOARDS_API_RATE; burst = $env:BOARDS_API_BURST; connections = $env:BOARDS_CONNECTIONS
        gateway_directives = Get-EffectiveGatewayPolicy $logContainers.gateway
        main_project_before = $before
        ca_sha256 = (Get-FileHash -Algorithm SHA256 (Join-Path $local 'ca.crt')).Hash
    }
    $metaPath = Join-Path $result 'meta.json'
    [IO.File]::WriteAllText($metaPath, ($metadata | ConvertTo-Json -Depth 6), $utf8)
    foreach ($kind in 'Resources','Postgres') {
        $jobs += Start-Job -FilePath (Join-Path $PSScriptRoot 'capturar.ps1') `
            -ArgumentList $result, $db.POSTGRES_USER, $db.POSTGRES_DB, $kind
    }
    $setting = @(
        '-e', "BOARDS_EXPERIMENT=$Experiment",
        '-e', "BOARDS_RUN_TAG=$($tempId.Substring(0, 12))",
        '-e', "BOARDS_LEVEL=$Level",
        '-e', "BOARDS_WARMUP_SECONDS=$WarmupSeconds",
        '-e', "BOARDS_MEASURE_SECONDS=$MeasureSeconds"
    )
    $metrics = $null
    try {
        $output = @(docker compose @compose @k6 @setting k6-boards run --quiet /bench/boards_list.js)
        if ($LASTEXITCODE -ne 0) { throw "Fallo k6. Telemetria disponible en $result" }
        $summaryLines = @($output | Where-Object { $_ -clike 'BOARDS_SUMMARY *' })
        if ($summaryLines.Count -ne 1) { throw "Falta el resumen k6 en $result" }
        $summary = $summaryLines[0].Substring('BOARDS_SUMMARY '.Length)
        $metrics = ConvertFrom-Json -InputObject $summary
        if ($metrics.experiment -ne $Experiment -or $metrics.level -ne $Level -or
            $metrics.seconds -ne $MeasureSeconds -or $metrics.warmup -ne $WarmupSeconds) {
            throw 'Resumen k6 inesperado.'
        }
        [IO.File]::WriteAllText((Join-Path $result 'k6.json'), $summary, $utf8)
        Write-Output "Evidencia en $result"
        if ($jobs | Where-Object State -eq 'Failed') { throw 'Un capturador fallo. Revise la cobertura.' }
        if ($Action -eq 'Pilot' -and ($metrics.attempted -le 0 -or
            $metrics.attempted -ne $metrics.outcomes.success -or $metrics.dropped -ne 0 -or
            -not (Test-Path (Join-Path $result 'recursos.csv')) -or
            -not (Test-Path (Join-Path $result 'postgres.csv')))) {
            throw 'El piloto incumplio sus criterios; revise la evidencia.'
        }
    } finally {
        $start = $runStarted
        $end = [DateTimeOffset]::UtcNow
        if ($metrics.window_start_ms -gt 0) {
            $start = [DateTimeOffset]::FromUnixTimeMilliseconds([long]$metrics.window_start_ms)
            $end = $start.AddSeconds($metrics.seconds)
            if ($Action -eq 'Run' -and ($metrics.outcomes.timeout -or $metrics.outcomes.http_5xx -or $metrics.outcomes.transport)) {
                $wait = [Math]::Ceiling(($end.AddSeconds(35) - [DateTimeOffset]::UtcNow).TotalSeconds)
                if ($wait -gt 0) { Start-Sleep -Seconds ([Math]::Min(35, $wait)) }
            }
        }
        try {
            $metadata.log_capture = Export-BoardsLogs $logContainers $result $tempId.Substring(0, 12) `
                $start $end ([DateTimeOffset]::UtcNow)
        } catch {
            $metadata.log_capture_failed = $true
            Write-Warning 'La captura de logs no se completo.'
        }
        try {
            $after = @(Get-MainProjectState)
            $metadata.main_project_after = $after
            $metadata.main_project_changed = ($before -join "`n") -cne ($after -join "`n")
        } catch {
            $metadata.main_project_after_unavailable = $true
            Write-Warning 'No se pudo verificar el estado final del proyecto principal.'
        }
        $k6ImageId = docker image inspect --format '{{.Id}}' $metadata.k6_image 2>$null
        if ($LASTEXITCODE -eq 0) { $metadata.k6_image_id = $k6ImageId }
        [IO.File]::WriteAllText($metaPath, ($metadata | ConvertTo-Json -Depth 6), $utf8)
    }
} finally {
    if ($jobs.Count) {
        Stop-Job -Job $jobs
        Receive-Job -Job $jobs -ErrorAction Continue | Out-Null
        Remove-Job -Job $jobs
    }
    foreach ($name in $savedEnvironment.Keys) {
        [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], 'Process')
    }
    if (Test-Path -LiteralPath $modelPath) { Remove-Item -LiteralPath $modelPath }
    if ($Action -eq 'Config' -and (Test-Path -LiteralPath $envPath)) { Remove-Item -LiteralPath $envPath }
    $lock.Dispose()
}
