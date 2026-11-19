# S2 · Reverse Proxy — catálogo de ataques al borde

Responsable: Juan Sebastián Leguizamón · Rama: `p3/s2-proxy` · Ejecutor: [`s2_proxy.mjs`](s2_proxy.mjs)

## Qué es

La lista de peticiones con las que un atacante externo anónimo intenta saltarse el gateway: rutas
internas, métodos no previstos, cabeceras falsificadas, peticiones gigantes, lentas o en ráfaga,
rutas no publicadas y puertos de los servicios. Cada caso indica la petición exacta y el resultado
**esperado en el P3**. La columna del P2 (y la del P3) no se escribe a mano: la genera
[`s2_tabla.mjs`](s2_tabla.mjs) a partir del JSON de cada corrida.

La fuente única de los casos es `CATALOGO` en `s2_proxy.mjs`: la tabla de abajo se regenera desde
ahí, así que el texto de la tabla y lo que se ejecuta no pueden divergir.

## Cómo se ejecuta

```sh
# P3 (después), desde la raíz del repo con el stack levantado:
node security-tests/s2_proxy.mjs --target https://localhost:8443 --ca gateway/certs/ca.crt \
     --json docs/p3/evidencia/S2/despues/s2_proxy-p3.json

# P2 (antes), con el P2 levantado en un worktree aparte (git worktree add ../p2-baseline 6af0456):
node security-tests/s2_proxy.mjs --target http://localhost:8088 --pixels-ui http://localhost:3000/ \
     --compose-dir ../p2-baseline --json docs/p3/evidencia/S2/antes/s2_proxy-p2.json

# Tabla P2 -> P3 (reescribe el bloque marcado de este archivo):
node security-tests/s2_tabla.mjs --antes docs/p3/evidencia/S2/antes/s2_proxy-p2.json \
     --despues docs/p3/evidencia/S2/despues/s2_proxy-p3.json --escribir security-tests/s2_catalogo.md
```

Requisitos: Node ≥ 22 y Docker (para leer el access log y capturar el tramo interno). Imprime
`OK`/`FAIL` por caso y termina con código 1 si alguno falla.

## Cómo se decide cada caso

| Verificación | Casos | Criterio |
|---|---|---|
| Rechazo sin upstream (`log`) | A, B, C01–C02, D, E02–E04, F01–F03 | Estado y cuerpo JSON del gateway (sin HTML ni firma de Nginx) **y** la línea del access log con el `X-Request-ID` del caso tiene `us=-`: Nginx no consultó a ningún servicio. Si el gateway rechaza la petición antes de leer las cabeceras (A05, B02, D03: no hay `X-Request-ID` legible), el caso se ejecuta solo en su propio segundo y su línea se identifica por ese segundo, el estado y el `"método uri"` que registra el log, descartando las líneas de los demás casos. En E03 se exige además que el error log de Nginx registre `limiting connections` y ningún `limiting requests` (el rechazo debe venir del límite de conexiones y no del de tasa). |
| Normalización (`captura`) | C03–C07 | La petición legítima **sí** debe llegar al servicio, sin la cabecera falsificada. Se captura con `tcpdump` (`nicolaka/netshoot:v0.13`, en el espacio de red del gateway) el tramo interno gateway → servicio, que va en HTTP plano, y se buscan los valores falsificados. |
| Respuesta | C08–C10, F04, F05 | Se juzgan las cabeceras de la respuesta: `X-Request-ID` con formato estricto, cabeceras que delatan el stack y cabeceras de seguridad (una vez cada una, también en errores). |
| Tiempo | E01, E02 | El gateway corta la conexión lenta antes de 15 s (`--slow-max`); se observa hasta 25 s (`--slow-wait`). |
| Puertos | F06 | Fuente de verdad: los puertos que el stack publica (`docker compose ps`). Solo se admiten los del gateway y `127.0.0.1:15672` (consola de RabbitMQ). Además, conexión TCP desde el host a esos puertos y a los de servicios, bases y broker, en `127.0.0.1` y en las IP de la LAN. Un puerto abierto que el stack no publica pertenece a otro proceso del host: se informa y no cuenta. |

Por qué sockets crudos: `fetch` y `curl` (sin `--path-as-is`) normalizan la ruta (`/a/../b` → `/b`),
no envían CR/LF dentro de una cabecera y no permiten dejar una petición a medias. El script escribe
cada petición byte a byte (HTTP/1.1; con HTTPS negocia ALPN `http/1.1`).

Los **controles** (K01–K05) no son ataques: comprueban que el tráfico legítimo sigue funcionando y
deben dar `OK` en el P2 y en el P3.

## Catálogo y resultados

<!-- s2:tabla:inicio -->
<!-- Generado por: node security-tests/s2_tabla.mjs --antes docs/p3/evidencia/S2/antes/s2_proxy-p2.json. No editar a mano. -->

| Caso | Categoría · táctica | Petición exacta | Esperado en el P3 | Real en el P2 (P2 6af0456) |
|---|---|---|---|---|
| **K01** | Control · — | GET /healthz | 200 | **OK** 200 text/plain ok |
| **K02** | Control · — | GET /login | 200 text/html (web SSR) | **OK** 200 text/html <!DOCTYPE html><html lang="es"><head><meta charSet="utf-8"/><meta name… |
| **K03** | Control · — | GET /api/boards (sin sesión) | 401 JSON del servicio (sí llega al upstream) | **OK** 401 application/json {"detail":"No autenticado"} |
| **K04** | Control · — | GET /api/pixels/board | 200 | **OK** 200 application/json |
| **K05** | Control · — | GET <UI de Pixels> (P2 :3000/ · P3 /pixels/) | 200 text/html | **OK** http://localhost:3000/ → 200 text/html <!doctype html> <html lang="es"> <head> <meta charset="UTF-8" /> <link… |
| **A01** | Rutas internas · Limit access | GET /internal/events | 404 JSON del gateway, sin upstream | **OK** 404 application/json {"detail":"No encontrado"} · upstream: no (us=- en 1 línea) |
| **A02** | Rutas internas · Limit access | POST /internal/boards/b1/access | 404 JSON del gateway, sin upstream | **OK** 404 application/json {"detail":"No encontrado"} · upstream: no (us=- en 1 línea) |
| **A03** | Rutas internas · Limit access | GET //internal/events | 404 JSON del gateway, sin upstream | **OK** 404 application/json {"detail":"No encontrado"} · upstream: no (us=- en 1 línea) |
| **A04** | Rutas internas · Limit access | GET /INTERNAL/events | 404 JSON del gateway, sin upstream | **OK** 404 application/json {"detail":"No encontrado"} · upstream: no (us=- en 1 línea) |
| **A05** | Rutas internas · Limit access | GET /%2e%2e/internal/events (sin normalizar) | 400 o 404 JSON del gateway, sin upstream | **FAIL** 400 text/html <html> <head><title>400 Bad Request</title></head> <body> <center><h1>… · upstream: no (us=- en 1 línea, por ventana de tiempo) |
| **A06** | Rutas internas · Limit access | GET /api/boards/../internal/events (sin normalizar) | 404 JSON del gateway, sin upstream | **OK** 404 application/json {"detail":"No encontrado"} · upstream: no (us=- en 1 línea) |
| **A07** | Rutas internas · Limit access | GET /api/boards/%2e%2e/%2e%2e/internal/boards/b1/access | 404 JSON del gateway, sin upstream | **OK** 404 application/json {"detail":"No encontrado"} · upstream: no (us=- en 1 línea) |
| **A08** | Rutas internas · Limit access | GET /%69nternal/events (i codificada) | 404 JSON del gateway, sin upstream | **OK** 404 application/json {"detail":"No encontrado"} · upstream: no (us=- en 1 línea) |
| **A09** | Rutas internas · Limit access | GET /%2569nternal/events (doble codificación) | 404 JSON del gateway, sin upstream | **FAIL** 307 - /login?next=%2F%252569nternal%2Fevents · upstream: SÍ (us=307) |
| **A10** | Rutas internas · Limit access | GET /internal%2fevents (barra codificada) | 404 JSON del gateway, sin upstream | **OK** 404 application/json {"detail":"No encontrado"} · upstream: no (us=- en 1 línea) |
| **A11** | Rutas internas · Limit access | GET /api/chat/%2569nternal/events (doble codificación bajo un prefijo que se reenvía sin reescribir) | 404 JSON del gateway, sin upstream | **FAIL** 401 application/json {"detail":"No autenticado"} · upstream: SÍ (us=401) |
| **B01** | Métodos · Limit access | TRACE / HTTP/1.1 | 405 JSON del gateway, sin upstream | **FAIL** 405 text/html <html> <head><title>405 Not Allowed</title></head> <body> <center><h1>… · upstream: no (us=- en 1 línea) |
| **B02** | Métodos · Limit access | CONNECT <host>:<puerto> HTTP/1.1 | 400 o 405 JSON del gateway, sin upstream | **FAIL** 400 text/html <html> <head><title>400 Bad Request</title></head> <body> <center><h1>… · upstream: no (us=- en 1 línea, por ventana de tiempo) |
| **B03** | Métodos · Limit access | DELETE /login | 405 JSON del gateway, sin upstream | **FAIL** 200 text/html <!DOCTYPE html><html lang="es"><head><meta charSet="utf-8"/><meta name… · upstream: SÍ (us=200) |
| **B04** | Métodos · Limit access | PUT /api/auth/login | 405 JSON del gateway, sin upstream | **FAIL** 405 application/json {"detail":"Método no permitido"} · upstream: SÍ (us=405) |
| **C01** | Host y cabeceras · Validate input | GET / con Host: evil-s2.example | 421 JSON del gateway, sin upstream | **FAIL** 307 - /login · Location: /login · upstream: SÍ (us=307) |
| **C02** | Host y cabeceras · Validate input | GET http://evil-s2.example/ HTTP/1.1 (forma absoluta) con Host legítimo | 421 JSON del gateway, sin upstream | **FAIL** 307 - /login · Location: /login · upstream: SÍ (us=307) |
| **C03** | Host y cabeceras · Validate input | GET /api/boards con X-Forwarded-For: 203.0.113.66 | el servicio recibe X-Forwarded-For = IP real del cliente, sin el valor falsificado | **FAIL** 401 · el servicio recibió: X-Forwarded-Host: localhost:8088 \| X-Forwarded-For: 203.0.113.66, 172.19.0.1 · FALSIFICADO: 203.0.113.66 |
| **C04** | Host y cabeceras · Validate input | GET /api/boards con X-Real-IP: 203.0.113.77 | el servicio no recibe el X-Real-IP falsificado | **FAIL** 401 · el servicio recibió: X-Forwarded-Host: localhost:8088 \| X-Forwarded-For: 172.19.0.1 \| X-Real-IP: 203.0.113.77 · FALSIFICADO: 203.0.113… |
| **C05** | Host y cabeceras · Validate input | GET /api/boards con X-Service-Token: s2-token-falso-<corrida> | el servicio no recibe X-Service-Token | **FAIL** 401 · el servicio recibió: X-Forwarded-Host: localhost:8088 \| X-Forwarded-For: 172.19.0.1 \| X-Service-Token: s2-token-falso-ebdcb3 · FALSIFI… |
| **C06** | Host y cabeceras · Validate input | GET /api/boards con X-User-Id: s2-usuario-falso-<corrida> | el servicio no recibe X-User-Id | **FAIL** 401 · el servicio recibió: X-Forwarded-Host: localhost:8088 \| X-Forwarded-For: 172.19.0.1 \| X-User-Id: s2-usuario-falso-ebdcb3 · FALSIFICADO… |
| **C07** | Host y cabeceras · Validate input | GET /api/boards con X-Forwarded-Host: evil-s2.example y Forwarded: for=203.0.113.88;host=evil-s2.example;proto=http | el servicio no recibe evil-s2.example ni 203.0.113.88 | **FAIL** 401 · el servicio recibió: X-Forwarded-Host: localhost:8088 \| X-Forwarded-For: 172.19.0.1 \| Forwarded: for=203.0.113.88;host=evil-s2.example… |
| **C08** | Host y cabeceras · Validate input | GET /api/boards con X-Request-ID: abc def" us=200 up=10.0.0.1 (falsificar campos del log) | X-Request-ID reemplazado por uno generado (formato estricto) | **OK** 401 · X-Request-ID devuelto: "51f4839141f874546ab9cdc475604ed5" |
| **C09** | Host y cabeceras · Validate input | GET /api/boards con X-Request-ID seguido de una línea plegada (obs-fold: CRLF + espacio + X-Inyectada: s2) | 400 JSON, o X-Request-ID válido sin rastro de la línea inyectada | **FAIL** 400 text/html <html> <head><title>400 Bad Request</title></head> <body> <center><h1>… |
| **C10** | Host y cabeceras · Validate input | GET /api/boards con X-Request-ID que contiene un CR suelto (\r) + X-Inyectada: s2 | 400 JSON, o X-Request-ID válido sin rastro de la línea inyectada | **FAIL** 400 text/html <html> <head><title>400 Bad Request</title></head> <body> <center><h1>… |
| **D01** | Tamaños · Detect service denial | POST /api/boards con Content-Length: 2097152 (2 MiB > CLIENT_MAX_BODY_SIZE=1m) | 413 JSON del gateway, sin upstream | **FAIL** 413 text/html <html> <head><title>413 Request Entity Too Large</title></head> <body>… · upstream: no (us=- en 1 línea) |
| **D02** | Tamaños · Detect service denial | GET /login con una cabecera de 20 000 bytes | 400/431 JSON del gateway, sin upstream | **FAIL** 400 text/html <html> <head><title>400 Request Header Or Cookie Too Large</title></he… · upstream: no (us=- en 1 línea) |
| **D03** | Tamaños · Detect service denial | GET /login?q=<12 000 bytes> | 414 JSON del gateway, sin upstream | **FAIL** 414 text/html <html> <head><title>414 Request-URI Too Large</title></head> <body> <c… · upstream: no (us=- en 1 línea, por ventana de tiempo) |
| **D04** | Tamaños · Detect service denial | POST /api/auth/login con cuerpo JSON de 100 KiB (límite propio de la ruta) | 413 JSON del gateway, sin upstream | **FAIL** 400 application/json {"detail":"JSON inválido o demasiado grande"} · upstream: SÍ (us=400) |
| **E01** | Lentitud y volumen · Detect service denial | GET /login enviando una cabecera cada 2 s sin terminar nunca (slow headers) | el gateway cierra la conexión en <= 15 s | **FAIL** la conexión seguía abierta a los 25.0 s |
| **E02** | Lentitud y volumen · Detect service denial | POST /api/boards con Content-Length: 1000, 10 bytes de cuerpo y luego nada (slow body) | el gateway cierra en <= 15 s, sin upstream | **FAIL** la conexión seguía abierta a los 25.0 s |
| **E03** | Lentitud y volumen · Detect service denial | 120 conexiones desde una IP (una cada 50 ms, bajo la tasa de limit_req), cada una POST /api/boards con el cuerpo pendiente | las que superan el límite de conexiones por IP reciben 429 JSON al instante, sin upstream (error log: «limiting connections», sin «limiting requests») | **FAIL** 0/120 rechazadas al instante ({}); 120 retenidas por el gateway esperando el cuerpo · error log: 0 «limiting connections», 0 «limiting reque… · upstream: n/a |
| **E04** | Lentitud y volumen · Detect service denial | 300 GET /login en ráfaga (30 en paralelo) | 429 JSON con las cabeceras de seguridad, sin upstream | **FAIL** 0/300 limitadas: {"200":300} · upstream: n/a |
| **F01** | Exposición · Limit exposure | GET /s2-no-existe | 404 JSON del gateway, sin upstream | **FAIL** 307 - /login?next=%2Fs2-no-existe · upstream: SÍ (us=307) |
| **F02** | Exposición · Limit exposure | GET /api/s2-no-existe | 404 JSON del gateway, sin upstream | **FAIL** 307 - /login?next=%2Fapi%2Fs2-no-existe · upstream: SÍ (us=307) |
| **F03** | Exposición · Limit exposure | GET /api/canvas/boards/b1/otra-cosa | 404 JSON del gateway, sin upstream | **FAIL** 307 - /login?next=%2Fapi%2Fcanvas%2Fboards%2Fb1%2Fotra-cosa · upstream: SÍ (us=307) |
| **F04** | Exposición · Limit exposure | GET a 8 rutas (web, 5 APIs, 404 y UI de Pixels): cabeceras de respuesta | Server ausente o «nginx» sin versión; 0 cabeceras de los servicios (X-Powered-By, x-nextjs-*, …) | **FAIL** UI de Pixels localhost:3000/: server=nginx/1.31.9 |
| **F05** | Exposición · Limit exposure | GET /login, /api/boards, /s2-no-existe y UI de Pixels: cabeceras de seguridad | CSP (con frame-ancestors), nosniff, Referrer-Policy, Permissions-Policy y X-Frame-Options exactamente una vez; HSTS una vez con HTTPS | **FAIL** /login (200): sin content-security-policy · /api/boards (401): sin content-security-policy, sin x-content-type-options, sin referrer-policy,… |
| **F06** | Exposición · Limit access | Puertos publicados por el stack (docker compose ps) y TCP desde el host a 3000, 5432, 5672, 8000, 8001, 8002, 8080, 8081, 8090, 15432, 15433, 15434, 15435, 15672, 27017 en 127.0.0.1 y en las IP de la LAN | el stack solo publica los puertos del gateway y 127.0.0.1:15672; ningún otro puerto del stack responde | **FAIL** publicados por el stack: gateway 0.0.0.0:8088→80, pixels-ui 0.0.0.0:3000→80, rabbitmq 127.0.0.1:15672→15672 · indebidos: pixels-ui 0.0.0.0:3… |

- **P2** (P2 6af0456, 2026-11-19T21:51:45.496Z): ataques bloqueados o normalizados **9/39** · controles 5/5 · rechazos con `us=-` en el log 14/26.

<!-- s2:tabla:fin -->

## Notas

- Las tácticas son las de Bass, *Software Architecture in Practice*, §11.2: *Limit access*
  (restringir puntos de acceso y tipo de tráfico), *Limit exposure* (reducir lo que se alcanza desde
  un único punto de acceso), *Validate input* (filtrado, canonicalización y saneado de la entrada) y
  *Detect service denial* (reconocer el patrón de un ataque de denegación de servicio y cortarlo).
- C03–C07 tienen hoy un impacto latente en el P2: ningún servicio publicado confía en esas
  cabeceras (`/internal/*` está bloqueado, `AUTH_DEV_MODE=false` y uvicorn solo acepta cabeceras de
  proxy desde `127.0.0.1`). El caso mide que el borde **no las deja pasar**, no que hoy sean
  explotables.
- C08 ya se cumplía en el P2 (el mapa de `X-Request-ID` de `00-http.conf.template`); se conserva
  como regresión.
