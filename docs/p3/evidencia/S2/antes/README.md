# S2 · Evidencia del «antes» (P2)

Estado atacado: `main` en el commit `6af04566d772194e2852d52ab51a70ba91d33539` (merge de `integracion-prototipo-2`),
levantado aislado en un worktree (`git worktree add ../p2-baseline 6af0456`, proyecto Compose `p2-baseline`,
`.env` copiado de su `.env.example`). Fecha de la corrida: 2026-11-19 (UTC, ver las marcas de cada archivo).
El stack se bajó con `docker compose down -v` y se levantó de nuevo desde cero justo antes de la corrida.

Ejecutor: `security-tests/s2_proxy.mjs` del commit `050450c` (rama `p3/s2-proxy`). La corrida se hizo
con la versión de ese commit anterior a su reescritura (antes `5c96ef7`): la única diferencia es que
ahora F06 enmascara las IP de la máquina en su salida (4 líneas de `s2_proxy.mjs`); los casos y sus
criterios son los mismos.
Entorno: Windows 11 Pro, Docker Desktop (Docker 29.5.3, linux/amd64, 16 CPU, 7,7 GiB para Docker),
Docker Compose v5.1.4, Node v22.17.0.

## Resultado

| Medida | P2 |
|---|---|
| Ataques del catálogo bloqueados o normalizados | **9 / 39** (A01–A04, A06–A08, A10, C08) |
| Controles de tráfico legítimo | 5 / 5 |
| Rechazos con `us=-` en el access log | 14 / 26 de los casos verificados por log |
| Puertos publicados por el stack fuera del gateway y de `127.0.0.1:15672` | 1: `pixels-ui 0.0.0.0:3000→80` |
| Cabeceras que delatan la versión | `Server: nginx/1.31.9` en la UI de Pixels (`:3000`) |
| ZAP baseline | 0 FAIL · 5 WARN (CSP ausente, COEP/CORP, anti-CSRF, Content-Type en 307, no almacenable) · 63 PASS · 25 URL |

El detalle por caso está en `s2_proxy-p2.txt` y en `s2_proxy-p2.json`, y en la tabla de
`security-tests/s2_catalogo.md`, que se genera desde ese JSON.

## Archivos

| Archivo | Qué es |
|---|---|
| `s2_proxy-p2.txt` / `.json` | Salida del catálogo (OK/FAIL por caso, líneas de log y paquetes capturados del tramo interno) |
| `access-log-ataque.txt` | `docker compose logs --timestamps gateway` desde el inicio de la corrida (access log + error log) |
| `puertos.txt` | `docker compose ps` y `netstat -ano -p TCP` antes del ataque, con la atribución de cada puerto |
| `zap_p2.html` / `zap_p2.json` | Informes de ZAP baseline |
| `zap_p2-salida.txt` / `zap_p2-automation.yaml` | Salida de consola de ZAP y plan de automatización que generó |
| `zap_p2-access-log.txt` | Líneas del gateway durante el escaneo (para medir cobertura y 429) |

## Comandos exactos

```sh
# Catálogo (desde la raíz del repo, con el P2 en ../p2-baseline)
node security-tests/s2_proxy.mjs --target http://localhost:8088 --pixels-ui http://localhost:3000/ \
     --compose-dir ../p2-baseline --label "P2 6af0456" --json docs/p3/evidencia/S2/antes/s2_proxy-p2.json

# ZAP 2.17.0 (ghcr.io/zaproxy/zaproxy:stable, sha256:9624669db72f54d86c4b46a7064518bd9bf79d8c61a4c31befa9923489f328af)
# en la red edge del proyecto (nombre real obtenido con `docker network ls`) contra el servicio gateway:
docker run --rm --network p2-baseline_edge -v <carpeta>:/zap/wrk:rw ghcr.io/zaproxy/zaproxy:stable \
     zap-baseline.py -t http://gateway:80 -m 5 -j -r zap_p2.html -J zap_p2.json
```

Banderas de ZAP: `-m 5` (hasta 5 minutos de spider), `-j` (spider adicional de la imagen). Código de
salida 2 = hay WARN, sin FAIL. El P3 se escanea con exactamente las mismas banderas cambiando solo el
target (`https://gateway:443`).

## Notas para leer los datos

- **Por qué ZAP en la red `edge` y no desde el host:** en Docker Desktop, `--network host` no llega al
  `localhost` de Windows. Dentro de `edge` el contenedor resuelve `gateway` por el DNS de Docker y
  sus peticiones llevan `Host: gateway`.
- **Cobertura de ZAP:** 26 peticiones desde la IP del contenedor de ZAP (`172.19.0.4`), todas `200` o
  `307`, **ninguna `429`**: el límite de tasa no recortó el escaneo y no fue necesario subirlo. ZAP
  baseline es pasivo y sin sesión, así que recorre la superficie pública (`/`, `/login`, `/register`,
  `/favicon.svg` y los estáticos de `/_next`). Las rutas `/api/*`, los métodos y las cabeceras los
  cubre el catálogo.
- **IP enmascaradas:** las IP privadas de la máquina que sondea F06 (LAN y adaptador virtual de WSL)
  figuran como `a.b.x.x`. En esta corrida se enmascararon después de ejecutarla, con la misma regla
  que el script aplica desde entonces; 127.0.0.1 y las IP de las redes de Docker (172.19.0.0/16) se
  dejan tal cual.
- **Puertos:** 5432 y 8080 aparecen abiertos en el host, pero no los publica el stack (`docker compose ps`):
  son procesos de Windows ajenos a Docker. F06 los informa y no los cuenta.
- **C03–C07:** la falsificación llega al servicio (la captura del tramo interno muestra, por ejemplo,
  `X-Forwarded-For: 203.0.113.66, 172.19.0.1`), pero hoy su impacto es latente: ningún servicio
  publicado confía en esas cabeceras.
- **C01/C02:** con `Host: evil-s2.example`, el gateway reenvía el host falso a la web
  (`X-Forwarded-Host`, que la web usa para calcular su origen público en el BFF). La redirección que
  devuelve Next es relativa (`Location: /login`), así que no se observa un `Location` envenenado.
