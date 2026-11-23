# ADR 0012 · Reverse Proxy endurecido: el gateway como único punto de entrada

- **Estado:** aceptada · **Fecha:** 2026-11-19 · **Escenario:** P3 · S2 Reverse Proxy (Juan Sebastián Leguizamón)
- **Amplía:** [ADR 0006](0006-limite-de-tasa.md) (límites del gateway; sus zonas `api` y `auth` no cambian de valor)
- **Relacionadas:** [0001](0001-gateway-nginx-y-reescritura-de-rutas.md) (gateway y rutas), [0003](0003-redes-y-puertos-publicados.md) (puertos publicados), S1 · Secure Channel (TLS en el mismo gateway)

## Contexto
En el P2 el gateway enrutaba, pero no actuaba como frontera. El catálogo de ataques
(`security-tests/s2_catalogo.md`, 41 casos) contra el P2 (`6af0456`) bloqueó **9/41**
(`docs/p3/evidencia/S2/antes/`):
- `location /` enviaba a la web SSR cualquier ruta no declarada (`/s2-no-existe`, `/api/s2-no-existe`,
  `/%2569nternal/events` llegaban a `web-ssr`: `us=307`), y `/api/chat/` y `/api/pixels/` reenviaban
  cualquier sufijo (`/api/chat/%2569nternal/events` llegaba a `chat-api`: `us=401`).
- Ningún método estaba restringido: `DELETE /login` devolvía la página (`us=200`).
- El `Host` del cliente pasaba sin validar a la web (`X-Forwarded-Host`).
- `X-Forwarded-For` conservaba lo que enviaba el cliente; `X-Real-IP`, `X-Service-Token`, `X-User-Id` y
  `Forwarded` llegaban intactos al servicio (captura del tramo interno).
- Los errores del gateway (`TRACE`, `CONNECT`, 400, 413, 414, cabeceras enormes) eran la página HTML de Nginx.
- Tiempos por defecto (60 s), sin límite de conexiones por IP: una conexión lenta seguía abierta a los 25 s
  y 120 conexiones con el cuerpo pendiente quedaban retenidas.
- `pixels-ui` se publicaba en `0.0.0.0:3000`, saltándose el gateway, con `Server: nginx/1.31.9`.

## Decisión
El gateway es el **único punto de entrada** y una frontera de lista blanca: todo lo que no está
declarado se rechaza en él, con JSON, sin llegar a ningún servicio (`us=-` en el access log).

1. **Lista blanca de rutas** (`gateway/templates/snippets/api-routes.conf.template` y
   `web-routes.conf.template`). Cada `location` acepta solo la forma real de sus rutas, con segmentos
   `[A-Za-z0-9_-]`: auth `/api/auth/<acción>`, colaboración, invitaciones, canvas, chat
   `/api/chat/boards/{id}/messages`, las cinco rutas REST de Pixels, notificaciones, los tres WebSocket,
   y en la web las páginas del build (`/`, `/login`, `/register`, `/boards/{id}`, `/join/{token}`),
   `/session/expired`, `/bff/api/*`, `/_next/static/*` y los dos SVG de `public/`. Lo demás cae en
   `location /` → `404` JSON del gateway. `/internal/*` sigue bloqueado en cualquier prefijo.
2. **Métodos** con `limit_except` por servicio (otro método → `405` JSON). La cabecera `Allow` sale del
   `map $gw_allow_by_route` (`10-hardening.conf.template`), que debe coincidir con cada `limit_except`:
   con un método denegado, `limit_except` cambia de configuración antes del rewrite y un `set` en la
   `location` no se ejecuta.
3. **Host**: lista blanca `GATEWAY_ALLOWED_HOSTS` (por defecto `localhost,127.0.0.1,gateway`; la regex
   exacta la arma `gateway/allowed-hosts.envsh`). Otro `$host` → `421` JSON en `:443` y en `:80`, antes
   de cualquier `location`; así la redirección 301 de S1 ya no usa un host ajeno.
4. **Saneado de entrada** (`gateway/snippets/proxy-sanitize.conf`, incluido desde `proxy-common.conf` y
   `proxy-ws.conf`). En los servidores públicos, `X-Forwarded-For` y `X-Real-IP` son la IP que ve el
   gateway; en el interno (`:8081`, solo web-ssr) se conserva la cadena que reenvía la web. Se eliminan
   `X-Service-Token`, `X-User-Id`, `Forwarded`, `X-Forwarded-Port/-Prefix/-Server/-Ssl`, `X-Original-URL`,
   `X-Rewrite-URL`, `X-HTTP-Method(-Override)`, `X-Method-Override` y las variantes de IP de cliente
   (`True-Client-IP`, `X-Client-IP`, …). `X-Request-ID` mantiene el filtro del P2 (`^[A-Za-z0-9._-]{8,64}$`).
5. **Cabeceras de seguridad con dueño único** (`security-headers.conf.template`): el gateway oculta las
   que envían los servicios (`proxy_hide_header`; web-ssr ya enviaba `X-Frame-Options`, `nosniff`,
   `Referrer-Policy`, `Permissions-Policy` y COOP) y emite una sola vez, con `always`: CSP,
   `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: same-origin`,
   `Permissions-Policy: camera=(), microphone=(), geolocation=()`, COOP y CORP `same-origin`. Ninguna
   `location` declara `add_header` (tampoco las de error), así que todas heredan estas, `X-Request-ID` y
   el HSTS de S1, que no se duplica.
   - **CSP**: `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline';
     img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' wss://$host:${GATEWAY_TLS_PORT};
     frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'`. Bloqueante.
     `'unsafe-inline'` es necesario porque Next.js hidrata con scripts en línea y sin nonce (un nonce
     exige cambiar web-ssr).
   - Solo en `/pixels/`: la UI de Pixels carga Google Fonts desde su `index.html`. La política bloqueante
     de esa ruta admite `https://fonts.googleapis.com` (estilos) y `https://fonts.gstatic.com` (fuentes),
     y una `Content-Security-Policy-Report-Only` con la regla estricta deja constancia del uso en la consola.
6. **Exposición**: `server_tokens off` (ya en el P2) y `proxy_hide_header` de `X-Powered-By`,
   `X-AspNet-Version`, `X-AspNetMvc-Version`, `X-Runtime`, `X-Generator` y `Via`.
7. **Errores del gateway en JSON** (`error-pages.conf.template`): 400, 405, 408, 413, 414, 421, 429, 431,
   500, 502, 503 y 504. Los que ocurren al leer la línea de petición (400, 414, 494→431) van por una URI
   interna (`/__gw/*`), porque sin URI Nginx no puede saltar a una `location` con nombre; `types { }`
   impide que un error sobre `/x.js` salga como `application/javascript`.
8. **Límites** (amplía la ADR 0006; `10-hardening.conf.template` y las `location`):

   | Límite | Valor | Variable | Por qué este valor (medido; `docs/p3/evidencia/S2/despues/`) |
   |---|---|---|---|
   | `client_header_timeout` (total), `client_body_timeout`, `send_timeout` | 10 s | — | Un cliente legítimo envía las cabeceras en milisegundos; cortan *slowloris*, cuerpo detenido y lector lento |
   | `large_client_header_buffers` | 4 × 8 KiB | — | El valor por defecto, ahora explícito; > 8 KiB → 414/431 JSON |
   | `client_max_body_size` | 1 MiB general; 16 KiB auth, chat, Pixels y notificaciones; 64 KiB páginas; 256 KiB BFF (el tope del propio BFF); 1 KiB rutas solo GET | `CLIENT_MAX_BODY_SIZE`, `CLIENT_MAX_BODY_SIZE_AUTH` | Cuerpos reales: login/registro < 1 KiB; mensaje de chat ≤ 2000 caracteres |
   | Zona `web` (páginas, `/bff/`, `/session/expired`; no `/_next/static`) | 20 r/s, ráfaga 100 | `RATE_LIMIT_WEB`, `RATE_LIMIT_WEB_BURST` | Peor segundo medido: 19 peticiones (navegador) y 13 (E2E con varios usuarios); 0 respuestas 429 en el E2E |
   | `limit_conn conn` por IP | 60 | `LIMIT_CONN_PER_IP` | Pico medido de 11–12 peticiones simultáneas por navegador (HTTP/2: cada stream cuenta) |
   | `limit_conn conn_ws` por IP en las `location` de WebSocket | 30 | `LIMIT_CONN_WS_PER_IP` | Pico de 4 WebSocket abiertos por navegador; cada uno ocupa su conexión mientras dure |

   Las zonas `api` y `auth` del P2 conservan sus valores. Exceso → `429` JSON con `Retry-After: 1`.
   Todos los límites nuevos usan la clave `$rl_key` (vacía en el servidor interno = sin límite) y se suben
   por variable (p. ej. `LIMIT_CONN_PER_IP=100000`, `RATE_LIMIT_WEB=100000r/s`) para las pruebas de rendimiento.
9. **pixels-ui detrás del gateway** en `/pixels/`: se quita `3000:80` del compose, la SPA se construye
   con `VITE_BASE_PATH=/pixels/` y `PUBLIC_PIXELS_URL=https://localhost:8443/pixels/`. Gateway y
   `pixels-ui` comparten la red `edge`, así que no cambian las redes (S3).

## Alternativas
- *Mantener el `location /` del P2 y confiar en el 404 de Next:* las rutas no declaradas (y las de doble
  codificación) seguían llegando a `web-ssr` (`us=307` en el P2); además, cada error sería HTML de la web.
- *Rechazar con 400 las peticiones con cabeceras de proxy en vez de eliminarlas:* rompe a clientes
  legítimos detrás de otro proxy sin aportar más que el saneado; basta con que no crucen.
- *Validar el Host con `server_name` y un servidor por defecto que responda 421:* equivalente, pero cada
  nombre nuevo (p. ej. la IP de la LAN para la prueba de rendimiento con `TLS_EXTRA_SAN`) exigiría editar
  la plantilla; la variable lo resuelve sin tocar código.
- *CSP con nonces y sin `'unsafe-inline'`:* requiere que web-ssr genere el nonce por petición (en
  `proxy.ts`), fuera del alcance de S2. *CSP solo Report-Only en todo el sitio:* no protege.
- *Quitar también `Server: nginx` (módulo headers-more u OpenResty):* obliga a cambiar la imagen del
  gateway; se acepta «nginx» sin versión.
- *Límites por usuario (JWT) en el gateway:* la ADR 0006 ya descartó decodificar el JWT en el borde.
- *`pixels-ui` solo en `127.0.0.1:3000`:* seguiría siendo una segunda entrada sin TLS ni cabeceras.
- *Un WAF (ModSecurity/Coraza):* más cobertura de firmas a cambio de otra pieza, reglas que mantener y
  falsos positivos; la lista blanca de rutas y métodos cubre los casos del catálogo.

## Consecuencias
- (+) Catálogo: **41/41** casos bloqueados o normalizados (P2: 9/41) y **28/28** rechazos sin upstream
  (`us=-`); 0 cabeceras falsificadas en el tramo interno; 0 puertos del stack publicados salvo el gateway
  y la consola de RabbitMQ en loopback; conexiones lentas cortadas a los 10 s; la aplicación sigue
  funcionando (E2E 4/4, `ws_check`, smoke, recorrido en el navegador sin violaciones bloqueantes de CSP,
  0 respuestas 429 al tráfico legítimo). `docs/p3/evidencia/S2/`.
- (−) **Acoplamiento**: una página o ruta nueva de un servicio exige declararla en el gateway (lo que el
  reparto ya pide en su §3.2: avisar a S2). Las rutas de S4 (`/auth/refresh`, `/auth/logout`) ya caben en
  `/api/auth/<acción>`. La tabla `Allow` debe mantenerse igual a cada `limit_except` (el contrato del
  gateway lo comprueba en 6 rutas).
- (−) **Límites por IP**: los usuarios tras un NAT comparten cuota. Margen sobre lo medido en un
  navegador: 60 frente a 12 peticiones simultáneas (×5), 30 frente a 4 WebSocket (×7,5) y una ráfaga de
  100 frente a 19 peticiones en el peor segundo (×5; la tasa sostenida de 20 r/s queda justo por encima
  de ese pico, y es la ráfaga la que absorbe la carga de una página). Las pruebas de carga, que salen de
  una sola IP, deben subirlos por variable.
- (−) **Riesgos residuales declarados**: `script-src`/`style-src 'unsafe-inline'` (ZAP 10055, Medium);
  `Server: nginx` sin versión; `Vary: rsc, next-router-…` y las cabeceras `x-nextjs-*` que Next envía a su
  propio cliente (no se ocultan porque su router las lee); sin COEP; Google Fonts como tercero en
  `/pixels/`. `limit_conn` cuenta peticiones en curso, no conexiones inactivas: muchas conexiones
  *keep-alive* o *slowloris* desde una IP solo quedan acotadas por los 10 s de `client_header_timeout`;
  limitarlas por IP exige un control de capa 4 fuera de Nginx.
- (−) El servidor interno (`:8081`) confía en el `X-Forwarded-For` que envía web-ssr: es aceptable porque
  solo web-ssr lo alcanza en la red interna (S3).
