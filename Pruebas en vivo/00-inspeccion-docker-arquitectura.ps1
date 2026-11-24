# Prueba en vivo 00 · Inspeccion de arquitectura Docker (16 contenedores, puertos, 8 redes, recursos)
# Util cuando el profesor pregunta como dockerizan, por que esos contenedores y como estan aislados.
# Uso: powershell -ExecutionPolicy Bypass -File ".\Pruebas en vivo\00-inspeccion-docker-arquitectura.ps1"
param(
    [string]$Project = "collaboard"
)

$ErrorActionPreference = "Continue"

Write-Host "==================================================================" -ForegroundColor Cyan
Write-Host " PRUEBA EN VIVO 00 · ARQUITECTURA DOCKER (CONTENEDORES Y REDES)" -ForegroundColor Cyan
Write-Host "==================================================================" -ForegroundColor Cyan

Write-Host "`n[1/4] Contenedores activos y puertos publicados (solo gateway debe publicar :8088 y :8443):" -ForegroundColor Yellow
docker ps --filter "label=com.docker.compose.project=$Project" --format "table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}"

Write-Host "`n[2/4] Las 8 redes Docker, propiedad Internal y contenedores miembros:" -ForegroundColor Yellow
$nets = @("edge","app","net-user","net-board","net-canvas","net-notif","net-mongo","net-mq")
foreach ($n in $nets) {
    $full = "${Project}_$n"
    $internal = docker network inspect $full --format "{{.Internal}}" 2>$null
    if ($null -ne $internal) {
        $members = docker network inspect $full --format "{{range .Containers}}{{.Name}} {{end}}" 2>$null
        $color = if ($internal -eq "true") { "Green" } else { "Magenta" }
        Write-Host ("  {0,-22} | Internal={1,-5} | Miembros: {2}" -f $full, $internal, $members.Trim()) -ForegroundColor $color
    }
}

Write-Host "`n[3/4] Puertos publicados en el host (verificacion de Single Entry Point):" -ForegroundColor Yellow
$pub = docker ps --filter "label=com.docker.compose.project=$Project" --format "{{.Names}} -> {{.Ports}}" | Where-Object { $_ -match "0\.0\.0\.0|:::" }
if ($pub) {
    $pub | ForEach-Object { Write-Host "  $_" -ForegroundColor White }
} else {
    Write-Host "  (Ningun contenedor activo con puertos publicados en $Project)" -ForegroundColor DarkGray
}

Write-Host "`n[4/4] Consumo actual de CPU y memoria por contenedor:" -ForegroundColor Yellow
$ids = docker ps -q --filter "label=com.docker.compose.project=$Project"
if ($ids) {
    docker stats --no-stream --format "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}" $ids
}

Write-Host "`nInspeccion finalizada." -ForegroundColor Green
