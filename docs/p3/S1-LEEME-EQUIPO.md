# S1 · Secure Channel: qué cambió y qué deben tener en cuenta (léanlo antes de seguir)

Responsable: Jhon Prieto · Rama: `p3/s1-tls` · Detalle técnico completo: [`fragmentos/S1-canal-seguro.md`](fragmentos/S1-canal-seguro.md)

## 1. Qué cambió, en una línea

El gateway ahora sirve **HTTPS** (TLS 1.2/1.3 y HTTP/2) en `https://localhost:8443`. El puerto `8088` (HTTP)
solo redirige a HTTPS. Dentro de la red de contenedores todo sigue en HTTP, igual que antes.

## 2. Lo que tienen que hacer TODOS (una sola vez)

1. **Actualizar el `.env`.** Copien de `.env.example` la sección *Acceso público*: `GATEWAY_TLS_PORT=8443`,
   `PUBLIC_ORIGIN=https://localhost:8443`, `CHAT_ALLOWED_ORIGINS=https://localhost:8443,https://127.0.0.1:8443`,
   `SESSION_COOKIE_SECURE=true`, `TLS_HSTS_MAX_AGE=300` y `TLS_EXTRA_SAN=`. Con los valores viejos (http)
   fallan las verificaciones de origen (por ejemplo, Chat rechaza el WebSocket del navegador) y la cookie
   no sale con `Secure`.
2. **Levantar como siempre:** `docker compose up -d --build --wait`. Al arrancar, el gateway crea solo su
   certificado de desarrollo en `gateway/certs/` (no se versiona).
3. **Confiar en la CA (opcional; quita la advertencia del navegador):**
   Windows `certutil -user -addstore Root gateway\certs\ca.crt` · macOS
   `sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain gateway/certs/ca.crt`.
   Es seguro: la CA solo puede firmar `localhost` y su llave se destruye al crearla.
4. **Usar el sistema por `https://localhost:8443`** (no por 8088).

## 3. Herramientas de prueba (ya adaptadas)

| Herramienta | Cómo se usa ahora |
|---|---|
| Smoke del gateway | `CURL_CA_BUNDLE=gateway/certs/ca.crt sh scripts/gateway_smoke.sh https://localhost:8443` |
| WebSocket | `NODE_EXTRA_CA_CERTS=gateway/certs/ca.crt node scripts/ws_check.mjs https://localhost:8443` (usa `wss://`) |
| E2E (Playwright) | `WEB_SSR_URL=https://localhost:8443 pytest e2e/test_web_ssr.py e2e/test_notifications.py` |
| Contrato del gateway | `NODE_EXTRA_CA_CERTS=gateway/tests/certs/ca.crt node --test gateway/tests/contract.test.mjs` (el banco publica `18443`…`18446`) |
| Escenario S1 | `python security-tests/s1_tls.py` (12 comprobaciones) |
| k6 desde un contenedor | Entrar por la red `edge` a `https://gateway` con `SSL_CERT_FILE` apuntando a una CA que incluya `DNS:gateway` (`TLS_EXTRA_SAN=DNS:gateway`); ejemplo en `rendimiento/tls/` |

- `curl` de Git para Windows (Schannel) ignora `CURL_CA_BUNDLE`: usen `--cacert gateway/certs/ca.crt --ssl-no-revoke`
  (`gateway_smoke.sh` ya lo hace solo).
- El CI (`.github/workflows/ci.yml`) ya corre todo por HTTPS e incluye el paso de S1.

## 4. Por escenario: lo que toca a cada quien

| Escenario | Qué deben saber |
|---|---|
| **S2 · Reverse Proxy** | En `gateway/templates/default.conf.template` el servidor público ahora es `listen 443 ssl` + `http2 on` e incluye `snippets/tls.conf` (TLS + HSTS). El servidor `:80` **solo** tiene `/healthz` y `return 301`. Sus `snippets/hardening.conf` y `security-headers.conf` van en el servidor **:443** (y en `:80` si aplica). Ojo: un `add_header` dentro de un `location` anula los heredados (HSTS incluido). `pixels-ui` sigue publicado en `3000:80`, pero ya llama al gateway por `https/wss` (argumentos `VITE_*` en el compose). **Hallazgo para su prueba de escalado:** el pool de BD de collaboration-api (5 + 10 conexiones contra 40 hilos) se bloquea con 25 usuarios concurrentes (timeouts de 8 s de web-ssr). Está en `main`. |
| **S3 · Network Segmentation** | El gateway publica ahora `8088:80` y `8443:443` y monta el volumen `./gateway/certs:/etc/nginx/certs`. Si `edge` pasa a ser la única red con salida al host, ambos puertos van ahí. **Imagen de despliegue del P2 con errores:** los puertos 8001, 8002… de la izquierda no se publican en ningún compose, y pixels-ui es `3000→80` (no `3001→3080`); está corregido en gris en `diagramas/vista-despliegue.S1.drawio`. |
| **S4 · Sesión JWT** | `SESSION_COOKIE_SECURE=true` por defecto: la cookie `cb_session` (y la futura de refresco) solo viaja por HTTPS. Si prueban por `http://` el navegador no la guarda. El E2E ya comprueba el atributo `Secure`. |
| **S5 · RBAC** | Sin impacto en la lógica; solo usar `https://localhost:8443` y las herramientas de la sección 3. |

## 5. Diagramas

- No existía ninguna fuente editable de las vistas del P2 (solo `.jpg`; revisadas las 17 ramas y todo el historial).
- **Base C&C (mi entrega de línea base):** `diagramas/base/vista-cc.base.drawio`, con las correcciones del
  reparto (notificaciones en C# real, redes `edge`/`internal`) y pixels-ui ya no opcional.
- **Mis cuatro vistas S1:** `diagramas/vista-cc.S1`, `vista-despliegue.S1`, `vista-capas.S1` y
  `vista-descomposicion.S1` (`.drawio` + `.png`), redibujadas fieles al P2. **Azul** = S1; **gris** = correcciones
  contra `docker-compose.yml`. Lista exacta de cambios: `diagramas/CAMBIOS-S1.md`.
- Para fusionar: copien los elementos azules sobre las bases cuando estén. Si les sirve, pueden usar mis
  vistas como punto de partida de despliegue, capas y descomposición.

## 6. Dónde está cada cosa

| Ruta | Qué es |
|---|---|
| `gateway/templates/snippets/tls.conf.template`, `gateway/templates/default.conf.template` | Configuración TLS y servidores :443 / :80 |
| `gateway/gen-dev-cert.sh`, `gateway/Dockerfile` | Certificado de desarrollo creado al arrancar |
| `docker-compose.yml`, `.env.example`, `.gitignore` | Puertos, volumen, orígenes HTTPS, cookie `Secure`, certificados fuera de git |
| `security-tests/s1_tls.py`, `security-tests/s1_wireshark.py` | Verificación del escenario y captura con Wireshark |
| `docs/p3/evidencia/S1/` | Capturas `.pcapng`, imágenes antes/después y pantallazos (`capturas/`) |
| `rendimiento/tls/` | Prueba de rendimiento "costo de TLS" (ficha, scripts, datos y gráficas) |
| `docs/p3/fragmentos/S1-canal-seguro.md` | Texto de S1 para el PDF final (8 secciones) |
| `docs/adr/0007-tls-descartado.md` | Marcada como reemplazada por S1 |

## 7. Resultados en una tabla

| | P2 | P3 |
|---|---|---|
| Correo / contraseña / JWT / chat legibles en Wireshark | 28 / 42 / 131 / 41 | **0 / 0 / 0 / 0** |
| `security-tests/s1_tls.py` | 7 FAIL | **12/12 OK** |
| Costo de TLS con conexiones reutilizadas (CPU del gateway por petición) | 138 µs | **137 µs** (sin costo medible) |
| Límite con handshake completo en cada petición (gateway con 1 CPU) | — | ~1200 conexiones nuevas/s |

## 8. Orden de integración

Mi PR va hacia `integracion-prototipo-3` (cuando exista) **después de S3 y S2**, como dice el reparto. Si
alguien toca `gateway/templates/default.conf.template` o el bloque `gateway` del compose antes, avísenme para
hacer el rebase sin perder el TLS.
