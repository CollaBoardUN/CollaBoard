# S2 · Evidencia del «después» (P3)

Estado atacado: rama `p3/s2-proxy`, gateway del commit `7d7b9ca` (la configuración de Nginx no cambió
después), levantado desde cero con `docker compose down -v && docker compose up -d --build --wait`
(`levantar-desde-cero.txt`: exit 0; 13 servicios `healthy` y 3 sin healthcheck definido desde el P2:
`message-worker`, `notification-api`, `pixels-ui`). Fecha: 2026-11-19 (UTC).
Ejecutor: `security-tests/s2_proxy.mjs` con el contenido del commit `1258f75` (el mismo del «antes»;
después solo cambió una línea informativa de su salida).
Entorno: el mismo del «antes» (Windows 11 Pro, Docker Desktop 29.5.3, Compose v5.1.4, Node v22.17.0).

## Resultado

| Medida | P2 (`../antes/`) | P3 |
|---|---|---|
| Ataques del catálogo bloqueados o normalizados | 9 / 41 | **41 / 41** |
| Controles de tráfico legítimo | 5 / 5 | 5 / 5 |
| Rechazos con `us=-` en el access log | 15 / 28 | **28 / 28** (`access-log-rechazos-us.txt`) |
| Puertos del stack publicados fuera del gateway y de `127.0.0.1:15672` | 1 (`pixels-ui 0.0.0.0:3000→80`) | **0** |
| Cabeceras que delatan versión o stack | `Server: nginx/1.31.9` (UI de Pixels) | **0** (queda `Server: nginx` sin versión) |
| Cabeceras falsificadas que llegan al servicio (C03–C07) | 5 / 5 | **0 / 5** (captura del tramo interno en el JSON) |
| Cabeceras lentas / cuerpo detenido | abiertas a los 25 s | cortadas a los **10,0 s** |
| Lector lento (207 234 B sin leer, 25 s) | recibe el archivo completo | cortado: **31 842 B** recibidos y conexión cerrada |
| 120 conexiones con el cuerpo pendiente desde una IP | 0 rechazadas | **60** rechazadas (429, `limiting connections` zona `conn`) |
| 40 WebSocket desde una IP | 0 rechazados | **10** rechazados (429, zona `conn_ws`) |
| Ráfaga de 300 `GET /login` | 0 limitadas | **172** limitadas (429 JSON con las cabeceras de seguridad) |
| ZAP baseline (mismas banderas) | 0 FAIL · 5 WARN · 25 URL | 0 FAIL · 5 WARN · 25 URL (tabla por alerta en `../README.md`) |

La tabla por caso «P2 → P3» está en `security-tests/s2_catalogo.md` (generada desde los dos JSON).

## La aplicación sigue funcionando

| Prueba | Resultado | Archivo |
|---|---|---|
| `sh scripts/gateway_smoke.sh` | exit 0, 23 OK | `gateway_smoke.txt` |
| `node scripts/ws_check.mjs` | exit 0, 14 OK (Pizarra, Chat y Pixels por `wss`) | `ws_check.txt` |
| E2E de Playwright (`e2e/test_web_ssr.py`, `e2e/test_notifications.py`) | 4 passed | `e2e.txt` |
| Recorrido en navegador con CSP (`security-tests/s2_navegador.py`) | 5/5 pasos; 0 violaciones bloqueantes; 0 errores JS; 0 respuestas 429 | `s2_navegador.txt` / `.json` |
| Regresión de S1 (`security-tests/s1_tls.py`) | 12/12 OK | `s1_tls-regresion.txt` |
| 429 al tráfico legítimo (smoke, ws_check, E2E, navegador) | 0 | `429-trafico-legitimo.txt` |
| Contrato del gateway (`gateway/tests/contract.test.mjs`) | 120/120 | `clon-limpio/contrato.tap` |

Medidas del recorrido en el navegador que calibran los límites (ADR 0012): 11 peticiones HTTP
simultáneas como máximo (HTTP/2: cada stream cuenta en `limit_conn`), 4 WebSocket abiertos a la vez y
19 peticiones en el peor segundo contra la zona `web`. En el E2E (varios usuarios desde la misma IP) el
peor segundo de la zona `web` fue de 13 peticiones.

## Verificación independiente (clon limpio)

`clon-limpio/`: clon de la rama en `1258f75` en un directorio temporal, `cp .env.example .env`,
`docker compose up -d --build --wait` (exit 0; el certificado de desarrollo se generó al arrancar) y el
catálogo: **41/41, 5/5, 28/28**, con veredicto idéntico al de `s2_proxy-p3.json` en los 46 casos. El
contrato del gateway desde el mismo clon: 120/120.

## Archivos

| Archivo | Qué es |
|---|---|
| `s2_proxy-p3.txt` / `.json` | Salida del catálogo contra el P3 |
| `access-log-rechazos-us.txt` | Por cada rechazo, su línea del access log con `us=-` (generado desde el JSON) |
| `access-log-ataque.txt` | `docker compose logs --timestamps gateway` durante la corrida (access log + error log) |
| `levantar-desde-cero.txt` | `down -v`, `up --build --wait` y `docker compose ps` con los puertos publicados |
| `contrato-D6-antes-despues.txt` | La aserción del P2 sobre rutas de canvas fuera del contrato (contrato de `0ac1014`) falla contra el gateway de S2 y la nueva pasa, con su línea `us=-` |
| `zap_p3.html` / `.json`, `zap_p3-salida.txt`, `zap_p3-automation.yaml`, `zap_p3-access-log.txt` | ZAP baseline contra el P3 |
| `gateway_smoke.txt`, `ws_check.txt`, `e2e.txt`, `s2_navegador.*`, `s1_tls-regresion.txt`, `429-trafico-legitimo.txt` | Pruebas de que la aplicación sigue funcionando |
| `clon-limpio/` | Verificación independiente desde un clon limpio |

## Comandos exactos

```sh
node security-tests/s2_proxy.mjs --target https://localhost:8443 --ca gateway/certs/ca.crt \
     --label "P3 7d7b9ca" --json docs/p3/evidencia/S2/despues/s2_proxy-p3.json

# ZAP: mismas banderas que en el P2; solo cambia el target (red edge del proyecto: colaboard_edge).
docker run --rm --network colaboard_edge -v <carpeta>:/zap/wrk:rw ghcr.io/zaproxy/zaproxy:stable \
     zap-baseline.py -t https://gateway:443 -m 5 -j -r zap_p3.html -J zap_p3.json
```

- **Certificado en ZAP:** el certificado de desarrollo no incluye `gateway` en su SAN y no hizo falta
  ninguna opción: ZAP no valida el certificado del destino (en ZAP 2.17.0 no existe
  `connection.sslAcceptAll`). Prueba de que el escaneo sí atravesó TLS: 25 peticiones desde la IP del
  contenedor de ZAP (`172.19.0.4`) en `zap_p3-access-log.txt`, todas `200`/`307`, ninguna `429`. El
  `Host: gateway` está en `GATEWAY_ALLOWED_HOSTS`.
- Los dos planes de automatización de ZAP (`zap_p2-automation.yaml`, `zap_p3-automation.yaml`) son
  idénticos salvo el target y el nombre del informe.
