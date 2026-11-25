## S2 — Reverse Proxy (gateway endurecido, punto único de entrada)

Responsable: Juan Sebastián Leguizamón Silva · Rama: `p3/s2-proxy` · ADR: [0012](../../adr/0012-reverse-proxy-endurecido.md) · Evidencia: [`docs/p3/evidencia/S2/`](../evidencia/S2/README.md)

### 1. Escenario de seguridad

| Parte | Contenido |
|---|---|
| Fuente | Atacante externo anónimo (sin cuenta) con acceso de red al equipo que publica el sistema |
| Estímulo | Intenta alcanzar `/internal/*` (en todas sus codificaciones) o los puertos de los servicios; falsifica `Host`, `X-Forwarded-*`, `X-Real-IP`, `X-Service-Token`, `X-User-Id` o `X-Request-ID`; usa métodos no previstos (`TRACE`, `CONNECT`, `DELETE` sobre páginas); envía peticiones malformadas, gigantes, lentas o en ráfaga |
| Artefacto | Borde del sistema: `gateway` (Nginx) y los puertos que publica el despliegue |
| Entorno | Operación normal: stack completo levantado con `docker compose up -d --build --wait`, TLS de S1 activo |
| Respuesta | El gateway es la única entrada; rechaza cada intento con un error JSON propio o lo normaliza antes de reenviarlo; los rechazos no llegan a ningún servicio; no revela versiones ni topología; el tráfico legítimo no se ve afectado |
| Medida | 100 % de los 41 casos del catálogo bloqueados o normalizados; 100 % de los rechazos con `us=-` en el access log (sin upstream); 0 cabeceras falsificadas en el tramo gateway → servicio; 0 cabeceras con versión y 0 cabeceras de los servicios internos (`X-Powered-By`, `x-nextjs-*`, …) en las respuestas, con `Server: nginx` sin versión como único residuo; 0 puertos del stack accesibles desde el host salvo el gateway (`8088`, `8443`) y la consola de RabbitMQ en `127.0.0.1`; conexiones lentas cortadas en ≤ 15 s; 0 respuestas 429 o fallos en el tráfico legítimo (E2E) |

### 2. Problema arquitectónico en el P2

En el P2 (`main` @ `6af0456`) el gateway enrutaba hacia seis APIs y la web, pero no actuaba como
frontera: lo que no era una ruta de API se enviaba entero a la web SSR (`location /`), reenviaba las
cabeceras del cliente, no restringía métodos ni tiempos, respondía errores con la página HTML de Nginx y
convivía con una segunda entrada pública (`pixels-ui` en `0.0.0.0:3000`).

**Evidencia reproducida.** El P2 se levantó aislado (`git worktree add ../p2-baseline 6af0456`,
`docker compose down -v && docker compose up -d --wait`) y se atacó con el catálogo
(`security-tests/s2_proxy.mjs`, sockets crudos: las rutas y las cabeceras salen sin normalizar):

```text
$ node security-tests/s2_proxy.mjs --target http://localhost:8088 --pixels-ui http://localhost:3000/ --compose-dir ../p2-baseline
FAIL A09 GET /%2569nternal/events (doble codificación)
       → 307 - /login?next=%2F%252569nternal%2Fevents · upstream: SÍ (us=307)
FAIL A11 GET /api/chat/%2569nternal/events
       → 401 application/json {"detail":"No autenticado"} · upstream: SÍ (us=401)
FAIL B01 TRACE / HTTP/1.1
       → 405 text/html <html> <head><title>405 Not Allowed</title></head> …
FAIL B03 DELETE /login
       → 200 text/html <!DOCTYPE html> … · upstream: SÍ (us=200)
FAIL C01 GET / con Host: evil-s2.example
       → 307 - /login · upstream: SÍ (us=307)
FAIL C03 GET /api/boards con X-Forwarded-For: 203.0.113.66
       → 401 · el servicio recibió: X-Forwarded-For: 203.0.113.66, 172.19.0.1 · FALSIFICADO: 203.0.113.66
FAIL C05 GET /api/boards con X-Service-Token: s2-token-falso-…
       → 401 · el servicio recibió: … X-Service-Token: s2-token-falso-99fdd5 · FALSIFICADO
FAIL D02 GET /login con una cabecera de 20 000 bytes
       → 400 text/html <html> <head><title>400 Request Header Or Cookie Too Large</title> …
FAIL E01 GET /login enviando una cabecera cada 2 s sin terminar nunca (slow headers)
       → la conexión seguía abierta a los 25.0 s
FAIL E03 120 conexiones desde una IP, cada una POST /api/boards con el cuerpo pendiente
       → 0/120 rechazadas al instante; 120 retenidas por el gateway esperando el cuerpo
FAIL E05 GET del estático más grande sin leer la respuesta (SO_RCVBUF=1 KiB, 25 s)
       → /_next/static/chunks/2nii411saqstq.js (207234 B): tras 25 s sin leer se recibieron 207234 B
FAIL F01 GET /s2-no-existe
       → 307 - /login?next=%2Fs2-no-existe · upstream: SÍ (us=307)
FAIL F04 cabeceras de respuesta de 8 rutas
       → UI de Pixels localhost:3000/: server=nginx/1.31.9
FAIL F06 puertos publicados por el stack
       → publicados: gateway 0.0.0.0:8088→80, pixels-ui 0.0.0.0:3000→80, rabbitmq 127.0.0.1:15672→15672 · indebidos: pixels-ui
Ataques bloqueados o normalizados: 9/41 · controles: 5/5 · rechazos con us=- en el log: 15/28
```

(Salida completa: `docs/p3/evidencia/S2/antes/s2_proxy-p2.txt`; líneas del access log de cada caso:
`antes/access-log-casos.txt`.) El P2 solo bloqueaba las variantes simples de `/internal`
(A01–A04, A06–A08, A10) y saneaba `X-Request-ID` (C08). En los casos C03–C07 la falsificación cruza el
gateway (la captura del tramo interno muestra el valor falsificado en el servicio). Su impacto hoy es
latente, porque ningún servicio publicado confía en esas cabeceras (`/internal/*` está bloqueado,
`AUTH_DEV_MODE=false` y uvicorn solo acepta cabeceras de proxy desde `127.0.0.1`), pero el borde no
debía dejarlas pasar.

### 3. Tácticas aplicadas

Nombres y categorías de Bass, *Software Architecture in Practice*, §11.2.

| Táctica | Categoría | Cómo se materializa en CollaBoard | Casos |
|---|---|---|---|
| **Limit access** | Resist attacks | Un solo punto de acceso: `pixels-ui` deja de publicar `3000:80` y se sirve en `/pixels/` detrás del gateway; el stack publica solo `8088`/`8443` (con S3, la consola de RabbitMQ ya no se publica por defecto). Tipo de tráfico restringido por punto de acceso: lista blanca de rutas y `limit_except` por servicio; `/internal/*` bloqueado en cualquier prefijo y codificación | A01–A11, B01–B04, F06 |
| **Limit exposure** | Resist attacks | Por el único punto de acceso solo se alcanzan las rutas declaradas (lo demás, 404 del gateway); las respuestas no revelan versión ni stack (`server_tokens off`, `proxy_hide_header`); la CSP, `frame-ancestors 'none'` y las demás cabeceras de seguridad acotan el daño de un XSS o de un *clickjacking* | F01–F05 |
| **Validate input** | Resist attacks | Canonicalización y saneado en el borde: `Host` contra `GATEWAY_ALLOWED_HOSTS` (421); `X-Forwarded-For` y `X-Real-IP` los fija el gateway; se eliminan `X-Service-Token`, `X-User-Id`, `Forwarded` y los *overrides* de método o ruta; `X-Request-ID` con formato estricto; segmentos de ruta `[A-Za-z0-9_-]` (un `%` restante tras decodificar, como en `%2569`, no encaja) | C01–C10, A09, A11 |
| **Detect service denial** | Detect attacks | El patrón de denegación se reconoce por umbrales por IP calibrados con tráfico legítimo medido: tasa (zona `web`), peticiones simultáneas (`conn`), WebSocket abiertos (`conn_ws`), duración de cabeceras, cuerpo y envío (10 s) y tamaño (cabeceras 8 KiB, cuerpo por ruta). Al detectarlo, el gateway corta (429, 408, 413, 414, 431) antes del servicio | D01–D04, E01–E06 |

Nota: Bass define *Detect service denial* como la comparación del tráfico con perfiles de ataques de
denegación conocidos. Aquí el «perfil» son esos umbrales por IP, fijados con datos (peor segundo, pico
de concurrencia; ver la sección 5), y la reacción inmediata (cortar o rechazar) también es resistencia.

### 4. Patrón aplicado: Reverse Proxy

- **Contexto.** Seis APIs en cinco lenguajes (Go, Python, Java, Rust, C#), una web SSR (Next.js) y una SPA
  (Pixels), detrás de un gateway Nginx que ya enrutaba y reescribía rutas (ADR 0001). Cada servicio valida
  su JWT, pero ninguno se diseñó para estar expuesto a Internet.
- **Problema.** Sin un borde que filtre, cada servicio recibe lo que el atacante envía: rutas no
  previstas, métodos, cabeceras de proxy falsificadas, peticiones malformadas o lentas. Endurecer cada
  servicio por separado (cinco *frameworks*) es caro e inconsistente, y una segunda entrada (`:3000`)
  deja sin efecto cualquier control del borde.
- **Solución.** Un proxy inverso como **único** punto de entrada que oculta la topología y aplica la
  política de borde antes de reenviar: lista blanca de rutas y métodos, validación de `Host`, saneado de
  cabeceras, cabeceras de seguridad de dueño único, límites de tamaño, tiempo, tasa y concurrencia por IP,
  y errores propios en JSON. Lo que no pasa la política se responde en el gateway (`us=-`).
- **Consecuencias / *trade-offs*.**
  - (+) Una sola política, probada en un solo sitio (contrato del gateway con 120 pruebas y catálogo de
    41 casos), para todos los servicios y lenguajes.
  - (−) Acoplamiento: una página o ruta nueva hay que declararla en el gateway (el reparto ya lo exige:
    «S4/S5/S6 no añaden rutas al gateway sin avisar a S2»). La tabla de la cabecera `Allow` debe coincidir
    con cada `limit_except`.
  - (−) El gateway es un punto único de fallo y de cuello de botella: si cae, cae la entrada (lo mitigaría
    tener varias réplicas tras un balanceador de capa 4, fuera del alcance del P3).
  - (−) Los límites por IP penalizan a los usuarios que comparten un NAT, y las pruebas de carga deben
    subirlos por variable.
  - (−) **Riesgos residuales declarados**:
    - `script-src` y `style-src 'unsafe-inline'`: Next.js hidrata con código en línea y quitarlo exige
      nonces en web-ssr.
    - `Server: nginx` sin versión.
    - `Vary: rsc, …` y las cabeceras `x-nextjs-*` de las páginas autenticadas: su router las lee.
    - No hay COEP, y en `/pixels/` se usa Google Fonts como tercero (con la regla estricta en Report-Only).
    - `limit_conn` cuenta peticiones en curso, no conexiones inactivas: muchas conexiones lentas desde
      una IP solo las acota `client_header_timeout` (10 s); acotarlas por IP requiere un control de
      capa 4 fuera de Nginx.
- **Dónde vive en el código.**

  | Archivo | Qué hace |
  |---|---|
  | `gateway/templates/10-hardening.conf.template` | Contexto `http`: tiempos, búferes, `map` de `Host`, IP del cliente, `Retry-After`, `Allow` y CSP por ruta; zonas `web`, `conn` y `conn_ws` |
  | `gateway/templates/snippets/hardening.conf.template` | Servidores públicos: validación de `Host` (421) y `limit_conn` por IP |
  | `gateway/templates/snippets/security-headers.conf.template` | CSP y demás cabeceras de seguridad |
  | `gateway/snippets/proxy-sanitize.conf` | Saneado de cabeceras hacia el servicio y ocultación de las del servicio |
  | `gateway/templates/snippets/api-routes.conf.template` · `web-routes.conf.template` | Lista blanca de rutas, `limit_except`, cuerpo por ruta, `/pixels/` |
  | `gateway/templates/snippets/error-pages.conf.template` | Errores del gateway en JSON |
  | `gateway/templates/default.conf.template` | `include` de lo anterior en `:443` y `:80`; `location /` → 404 |
  | `gateway/allowed-hosts.envsh`, `gateway/Dockerfile` | `GATEWAY_ALLOWED_HOSTS` → regex; valores por defecto de las variables |
  | `docker-compose.yml` (`gateway`, `pixels-ui`), `pixels-module/pixel-frontend/` | Variables del gateway; `pixels-ui` sin puerto y con base `/pixels/` |

### 5. Decisiones y alternativas

Resumen de la [ADR 0012](../../adr/0012-reverse-proxy-endurecido.md), que amplía la ADR 0006 (límites):

| Decisión | Alternativa descartada | Por qué |
|---|---|---|
| Lista blanca de rutas y `location /` → 404 del gateway | Mantener el `location /` del P2 y el 404 de Next | Las rutas no declaradas y las de doble codificación llegaban a web-ssr (`us=307`) |
| Eliminar las cabeceras de proxy falsificadas | Rechazar con 400 | Rompe a clientes legítimos detrás de otro proxy y no aporta más que impedir que crucen |
| `GATEWAY_ALLOWED_HOSTS` con 421 en `:443` y `:80` | Un `server_name` por nombre y un servidor por defecto | Añadir un nombre (IP de la LAN para la prueba de rendimiento) sería editar la plantilla |
| CSP bloqueante con `'unsafe-inline'` | Nonces (requiere tocar web-ssr) · solo Report-Only (no protege) | Prudente: protege `frame-ancestors`, `connect-src`, `object-src`, `base-uri` y `form-action` sin romper la hidratación; verificado sin violaciones bloqueantes en el navegador |
| Google Fonts permitido solo en `/pixels/`, con la regla estricta en Report-Only | Bloquearlo (la UI cae a la fuente del sistema) | Única violación encontrada; queda medida y visible sin romper la UI |
| `Server: nginx` sin versión | headers-more / OpenResty | Cambiar la imagen del gateway por una cabecera que no revela versión |
| `pixels-ui` en `/pixels/` detrás del gateway | Solo en `127.0.0.1:3000` | Seguiría siendo una segunda entrada sin TLS ni cabeceras; incumple la medida |
| Límites nuevos por IP con valores medidos y variables | Límites por usuario (JWT en el borde) | La ADR 0006 ya descartó decodificar el JWT en el gateway |

Valores y su justificación (medidos en `docs/p3/evidencia/S2/despues/s2_navegador.json` y en el E2E):
- **Zona `web`:** 20 r/s con ráfaga 100. El peor segundo legítimo fue de 19 peticiones (navegador) y de 13 (E2E).
- **`LIMIT_CONN_PER_IP`:** 60. El pico fue de 11 a 12 peticiones simultáneas por navegador; con HTTP/2 cada stream cuenta.
- **`LIMIT_CONN_WS_PER_IP`:** 30. El pico fue de 4 WebSocket abiertos.
- **Tiempos:** 10 s.
- **Cuerpo:** 16 KiB en auth, chat, Pixels y notificaciones; 64 KiB en las páginas; 256 KiB en el BFF; 1 MiB en el resto.

### 6. Verificación

El mismo catálogo, con el mismo script (`1258f75`), contra el P3 levantado desde cero
(`docker compose down -v && docker compose up -d --build --wait`):

```text
$ node security-tests/s2_proxy.mjs --target https://localhost:8443 --ca gateway/certs/ca.crt
OK   A09 GET /%2569nternal/events       → 404 application/json {"detail":"No encontrado"} · upstream: no (us=-)
OK   A11 GET /api/chat/%2569nternal/events → 404 application/json · upstream: no (us=-)
OK   B01 TRACE / HTTP/1.1               → 405 application/json {"detail":"Método no permitido."} · upstream: no (us=-)
OK   B03 DELETE /login                  → 405 application/json · upstream: no (us=-)
OK   C01 GET / con Host: evil-s2.example → 421 application/json {"detail":"Host no permitido."} · upstream: no (us=-)
OK   C03 X-Forwarded-For: 203.0.113.66  → el servicio recibió: X-Forwarded-For: 172.19.0.1 | X-Real-IP: 172.19.0.1
OK   C05 X-Service-Token falso          → el servicio recibió: X-Forwarded-For: 172.19.0.1 | X-Real-IP: 172.19.0.1
OK   D02 cabecera de 20 000 bytes       → 431 application/json · upstream: no (us=-)
OK   E01 slow headers                   → cerrada por el gateway a los 10.0 s
OK   E03 120 conexiones con cuerpo pendiente → 60/120 rechazadas al instante (429) · error log: 60 «limiting connections» (zona conn), 0 «limiting requests»
OK   E05 lector lento (207234 B)        → tras 25 s sin leer se recibieron 31842 B y la conexión terminó «cerrada»
OK   F01 GET /s2-no-existe              → 404 application/json · upstream: no (us=-)
OK   F04 cabeceras de 8 rutas           → solo «Server: nginx» sin versión
OK   F06 puertos publicados             → gateway 0.0.0.0:8088→80, gateway 0.0.0.0:8443→443, rabbitmq 127.0.0.1:15672→15672 · indebidos: ninguno
Ataques bloqueados o normalizados: 41/41 · controles: 5/5 · rechazos con us=- en el log: 28/28
```

Líneas del access log de cada rechazo (`despues/access-log-rechazos-us.txt`), por ejemplo:
`172.19.0.1 [2026-11-19T23:19:00+00:00] "GET /internal/events" 404 rid=s2-A01-92527f up=- us=- rt=0.000`.

| Medida de la respuesta (sección 1) | P2 | P3 (valor medido) | ¿Cumple? |
|---|---|---|---|
| Casos del catálogo bloqueados o normalizados | 9 / 41 | **41 / 41** | Sí |
| Rechazos sin upstream (`us=-`) | 15 / 28 | **28 / 28** | Sí |
| Cabeceras falsificadas en el tramo interno (C03–C07) | 5 / 5 | **0 / 5** | Sí |
| Cabeceras con versión o de servicios internos | 1 (`nginx/1.31.9`) | **0** (`Server: nginx`) | Sí, con el residuo declarado |
| Puertos del stack accesibles desde el host (salvo gateway y RabbitMQ en loopback) | 1 (`3000`) | **0** | Sí |
| Conexión lenta: cabeceras / cuerpo / lectura | abiertas a 25 s | **10,0 s / 10,0 s / cortada** | Sí (≤ 15 s) |
| Tráfico legítimo | — | E2E **4 passed**, smoke 23/23, `ws_check` 14/14, S1 12/12, **0** respuestas 429 | Sí |

Tabla completa caso por caso «P2 → P3», generada desde los dos JSON: `security-tests/s2_catalogo.md`.

**La aplicación sigue funcionando.** `security-tests/s2_navegador.py` recorre la web en Chromium (registro
por Server Action, tablero, dibujo por `wss`, UI de Pixels en `/pixels/` con su WebSocket): 5/5 pasos,
**0 violaciones de CSP bloqueantes**, 0 errores de JavaScript, 0 respuestas 429. Las únicas violaciones
reportadas son las del Report-Only de Google Fonts en `/pixels/`.

**Escáner.** ZAP 2.17.0 baseline con las mismas banderas (`-m 5 -j`) en la red `edge` contra `gateway`,
solo cambiando el target (`http://gateway:80` → `https://gateway:443`). Resultado: 0 FAIL y 5 WARN en
ambos casos, con 25 URL. Desaparecen «CSP Header Not Set» (Medium) y «Cross-Origin-Resource-Policy»
(Low); aparecen «CSP: script-src/style-src unsafe-inline» (Medium), el residuo declarado. Las alertas
Medium pasan de 2 a 3: ZAP pasa de «no hay CSP» a «hay CSP con `unsafe-inline`». Tabla por alerta:
`docs/p3/evidencia/S2/README.md`.

**Reproducción independiente.** Desde un clon limpio de la rama (`git clone`, `cp .env.example .env`,
`docker compose up -d --build --wait`), el catálogo da 41/41, 5/5 y 28/28, con veredicto idéntico en los
46 casos, y el contrato del gateway da 120/120 (`despues/clon-limpio/`).

### 7. Cambios en las vistas

Detalle por vista, con los elementos en verde de S2: [`docs/p3/diagramas/CAMBIOS-S2.md`](../diagramas/por-escenario/CAMBIOS-S2.md).

- **C&C.** `gateway` deja de ser una caja opaca y se muestra con sus módulos: lista blanca de rutas y
  métodos, validación de `Host`, saneador de cabeceras, limitador (tasa, conexiones y tiempos), cabeceras
  de seguridad, bloqueo de `/internal`, errores JSON y `X-Request-ID`. Todo conector externo pasa por él:
  el conector Browser → `pixels-ui` desaparece y se sustituye por Browser → `gateway` (`HTTPS :443 /pixels/`)
  y `gateway` → `pixels-ui` (`HTTP :80`, red `edge`). Estilo: *Reverse Proxy* («reverse proxy»).
- **Despliegue.** Solo publica puertos el `gateway` (`8088:80`, `8443:443`); la consola de RabbitMQ
  (`127.0.0.1:15672`) solo existe con `docker-compose.dev-ports.yml` desde S3. Desaparece `3000:80` de `pixels-ui`, que queda solo en la red `edge`. Este cambio
  corrige el texto del P2 que hablaba de dos puertos de producción («el gateway (8088) y el frontend
  pixels-ui (3000:80)»).
- **Capas.** En la Communication Tier, dentro de `gateway`, los módulos del proxy. `pixels-ui` deja de
  tener un conector directo al navegador sin pasar por el gateway.
- **Descomposición.** En el subsistema «Gateway y trazabilidad» → `gateway (Nginx)`, módulos nuevos:
  «Lista blanca de rutas y métodos», «Validación de Host», «Saneador de cabeceras», «Limitador de tasa y
  conexiones», «Cabeceras de seguridad», «Bloqueo de rutas internas» y «Errores JSON», junto a los del P2
  (*Proxy HTTP / WS*, *Enrutar a las APIs*, *X-Request-ID*) y al de S1 (*Terminación TLS y certificados*).

### 8. Rendimiento

S2 no tiene una prueba de rendimiento propia: el análisis de rendimiento del sistema se presenta en la sección
*Performance and Scalability* del documento (costo de TLS en el gateway, fan-out de WebSocket en Pixels y
notificaciones asíncronas con RabbitMQ, entre otras). Para que la política de borde no distorsione esas
mediciones, los límites por IP de S2 se elevan por variable de entorno durante las pruebas (p. ej.
`LIMIT_CONN_PER_IP=100000`, `RATE_LIMIT_WEB=100000r/s`; ver [ADR 0012](../../adr/0012-reverse-proxy-endurecido.md)).
