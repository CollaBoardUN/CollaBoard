## S1 — Secure Channel (TLS terminado en el gateway)

Responsable: Jhon Edison Prieto Artunduaga · Rama: `p3/s1-tls`

### 1. Escenario de seguridad

| Parte | Contenido |
|---|---|
| Fuente | Atacante pasivo o activo en la misma red (Wi-Fi/LAN) que el usuario: *sniffing* o *man-in-the-middle* |
| Estímulo | Intercepta el tráfico del login, la cookie `cb_session`, las llamadas a la API y los WebSocket |
| Artefacto | Canal navegador ↔ gateway (y pixels-ui ↔ gateway) |
| Entorno | Operación normal en una red no confiable |
| Respuesta | Todo el tráfico va cifrado y autenticado (TLS ≥ 1.2); HTTP plano solo redirige (301) a HTTPS; los WebSocket van por `wss://`; la cookie de sesión solo viaja cifrada (`Secure`) |
| Medida | 0 credenciales, tokens o mensajes legibles en la captura de una sesión completa; TLS 1.0/1.1 rechazados; TLS 1.3 negociado; 100 % de las rutas de la web y las APIs servidas por HTTPS; `Strict-Transport-Security` presente |

### 2. Problema arquitectónico en el P2

La ADR 0007 descartó TLS: el gateway escuchaba solo HTTP en `:80` (publicado como `8088`), la
cookie de sesión se emitía con `Secure=false` y los WebSocket iban por `ws://`. Cualquier equipo en la
misma red veía en claro todo lo que el navegador enviaba.

**Evidencia con Wireshark (P2, `main` @ `593b626`, sin cambios).** Wireshark 4.4.9 captura en la
interfaz de loopback del equipo mientras un navegador real se registra, inicia sesión por el
formulario, crea un tablero, dibuja y escribe en el chat (`security-tests/s1_wireshark.py`; captura y
guía en `docs/p3/evidencia/S1/wireshark/`). Con el filtro `http.request.method == "POST"`, el paquete
`POST /login` muestra en *MIME Multipart* `_1_email = victima-…@ejemplo.com` y `_1_password = S1-Clave-…!`;
*Follow HTTP Stream* muestra el `Set-Cookie: cb_session=eyJ…`, y el filtro `websocket`, el texto del chat.
En total, la disección de Wireshark contiene el correo 28 veces, la contraseña 42, el JWT 131 y el
mensaje 41.

**Verificación automática (P2).** Captura con `tcpdump` en la interfaz del gateway
(lo mismo que ve un *sniffer* en la LAN) mientras una cuenta se registra, inicia sesión por el
formulario de la web, crea un tablero y escribe en el chat:

```text
$ python security-tests/s1_tls.py --base http://localhost:8088 --ca "" --gateway p2base-gateway-1 \
    --evidence docs/p3/evidencia/S1/antes
FAIL HTTP plano solo redirige a HTTPS — la entrada pública es http://localhost:8088
FAIL el sistema ofrece HTTPS — la entrada pública es http://localhost:8088
FAIL cabecera Strict-Transport-Security — ausente (HTTP 200)
FAIL login por la web: cookie de sesión Secure; HttpOnly; SameSite — HttpOnly; SameSite=lax
FAIL WebSocket Pixels por wss:// — ws:// → HTTP/1.1 101 Switching Protocols
FAIL WebSocket Chat con cookie por wss:// — ws:// → HTTP/1.1 101
FAIL captura de red: 0 secretos legibles — correo: 3, contraseña: 3, JWT de sesión: 4, mensaje de chat: 2
```

Extracto del flujo TCP del login (`docs/p3/evidencia/S1/antes/s1-flujo-tcp.txt`, equivalente a
*Follow TCP Stream* de Wireshark; captura completa en `s1.pcap`):

```text
POST /login HTTP/1.1
Content-Disposition: form-data; name="email"
s1-13e38d00@ejemplo.com
Content-Disposition: form-data; name="password"
S1-Secreto-13e38d00-Clave!
HTTP/1.1 303 See Other
Set-Cookie: cb_session=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9…; Path=/; HttpOnly; SameSite=lax
POST /api/chat/boards/ca6da52d-…/messages HTTP/1.1
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9…
{"text": "mensaje-confidencial-13e38d00", …}
```

Con el JWT capturado, el atacante actúa como la víctima durante 1 hora (vida del token).

### 3. Tácticas aplicadas

| Táctica (Bass) | Categoría | Cómo se materializa en CollaBoard |
|---|---|---|
| Encrypt data | Resistir ataques | TLS 1.2/1.3 con suites AEAD y ECDHE (secreto hacia adelante) entre el navegador y el gateway (`gateway/templates/snippets/tls.conf.template`) |
| Authenticate actors | Resistir ataques | El gateway se autentica con un certificado X.509 (ECDSA P-256); el navegador lo valida contra la CA y el nombre del host |
| Verify message integrity | Detectar ataques | AEAD (AES-GCM/ChaCha20-Poly1305): cualquier byte alterado por un MITM rompe la conexión |
| Limit exposure | Resistir ataques | `:80` ya no sirve contenido: solo redirige (301); HSTS evita que el navegador vuelva a intentar HTTP; cookie `Secure` |

### 4. Patrón aplicado: Secure Channel

- **Contexto:** clientes web en redes no confiables que envían credenciales, tokens y mensajes al sistema.
- **Problema:** el canal en claro permite leer y modificar todo el tráfico (sniffing, MITM, robo de sesión).
- **Solución:** un canal cifrado y autenticado (TLS) entre el cliente y el punto único de entrada; el
  TLS termina en el gateway (*Gateway Offloading*) y los servicios no cambian.
- **Consecuencias:** (+) confidencialidad, integridad y autenticación del servidor en el tramo expuesto;
  un solo lugar para certificados y políticas. (−) costo de CPU y latencia del handshake (cuantificado
  en la sección 8); gestión de certificados; el tramo interno gateway → servicios sigue en HTTP.
- **Dónde vive en el código:**
  - `gateway/templates/snippets/tls.conf.template`: protocolos, suites, caché de sesión, HSTS.
  - `gateway/templates/default.conf.template`: servidor `:443 ssl` + `http2`, servidor `:80` que redirige.
  - `gateway/gen-dev-cert.sh` y `gateway/Dockerfile`: certificado de desarrollo al arrancar.
  - `docker-compose.yml`: puertos `8443:443` y `8088:80`, volumen `gateway/certs`, orígenes HTTPS,
    `SESSION_COOKIE_SECURE=true`, `VITE_*` de pixels-ui por `https`/`wss`.
  - `.env.example`: `GATEWAY_TLS_PORT`, `PUBLIC_ORIGIN`, `CHAT_ALLOWED_ORIGINS`, `TLS_HSTS_MAX_AGE`, `TLS_EXTRA_SAN`.

### 5. Decisiones y alternativas

| Decisión | Alternativas descartadas y por qué |
|---|---|
| Terminar TLS en el gateway | *TLS en cada servicio:* seis pilas TLS (Go, Python, Java, Rust, C#, Node), seis lugares para certificados y CPU de cifrado en cada servicio. *TLS de extremo a extremo (mTLS interno):* el valor está en el tramo expuesto; el interno queda en la red `internal`, sin puertos publicados, y se aísla más con S3 |
| Tramo interno en HTTP | `sslmode=require` hacia `user-db`: evaluado y no aplicado en el P3. Ese tráfico no sale de la red interna de Docker; con la segmentación de S3 solo `auth-api` alcanza `user-db`. Queda como mejora si las bases salen del host |
| TLS 1.2 y 1.3 (perfil *intermediate* de Mozilla), sin 1.0/1.1 | *Solo TLS 1.3:* deja fuera clientes antiguos sin ganancia práctica, porque 1.2 con ECDHE + AEAD no tiene debilidades conocidas. *Permitir 1.0/1.1:* sin suites AEAD, con PRF basado en MD5/SHA-1 y CBC con IV predecible en 1.0 (BEAST); deprecados por la RFC 8996 |
| `ssl_prefer_server_ciphers off` | Todas las suites admitidas son fuertes; el cliente elige la más rápida para su hardware (ChaCha20 en móviles sin AES por hardware) |
| Caché de sesión compartida, sin *session tickets* | *Tickets:* su llave no rota sola en Nginx; si se filtra, descifra sesiones pasadas (pierde el secreto hacia adelante) |
| HSTS `max-age=300` en desarrollo | Un valor de un año fijaría HTTPS en `localhost` para cualquier otro proyecto del equipo. En producción: `31536000` |
| CA local con `nameConstraints` y llave descartada, generada al arrancar | *Certificado autofirmado sin CA:* hay que confiar en él uno por uno. *mkcert:* otra herramienta que instalar. *CA local sin restricciones:* si su llave se filtrara, permitiría suplantar cualquier sitio en el navegador que confió en ella |
| Certificado ECDSA P-256 | *RSA 2048:* firma del handshake varias veces más cara en CPU para el gateway, con seguridad equivalente |
| `:80` redirige con 301 (salvo `/healthz`) | *Cerrar `:80`:* el usuario que escribe `localhost:8088` ve un error en vez de llegar a HTTPS. *Servir también por HTTP:* deja el canal inseguro disponible |

### 6. Verificación

**Con Wireshark (misma sesión real en el navegador, misma interfaz):**

![Wireshark antes y después](../evidencia/S1/wireshark/s1-wireshark-antes-despues.png)

| Lo que ve Wireshark | P2 (antes) | P3 (después) |
|---|---|---|
| Protocolos en la captura (*Statistics → Protocol Hierarchy*) | `http`, `mime_multipart`, `json`, `websocket` | solo `tls` |
| `POST /login` con correo y contraseña | legible | *Application Data* cifrado |
| Correo / contraseña / JWT / mensaje en la disección | 28 / 42 / 131 / 41 | **0 / 0 / 0 / 0** |
| La misma captura con las llaves que exportó el navegador (`SSLKEYLOGFILE`) | — | 16 / 24 / 90 / 36: la sesión sí está en la captura y solo el cifrado la protege |

El último renglón descarta que el 0 se deba a haber capturado otra cosa: la captura contiene la
sesión, pero sin los secretos de TLS (que solo tienen el navegador y el gateway) no se puede leer.
En el P3 también aparecen *Server Hello* sin certificado: es la reanudación de sesión.

Las mismas capturas abiertas en la interfaz de Wireshark:

![Wireshark, P2: las peticiones POST viajan en HTTP plano](../evidencia/S1/capturas/wireshark-antes-post-en-claro.png)

*P2 (`antes/captura.pcapng`), filtro `http.request.method == "POST"`: registro, login, creación del tablero
y mensaje de chat viajan en HTTP plano; el panel inferior muestra el formulario (`multipart/form-data`) legible.*

![Wireshark, P3: solo TLS 1.3](../evidencia/S1/capturas/wireshark-despues-solo-tls.png)

*P3 (`despues/captura.pcapng`), filtro `tls`: Client Hello (SNI `localhost`), Server Hello y Application Data;
ningún contenido legible.*

**Desde el navegador.** Con la CA de desarrollo importada (`certutil -user -addstore Root gateway\certs\ca.crt`),
Chrome abre `https://localhost:8443` sin advertencias e indica "La conexión es segura":

![Chrome: la conexión es segura](../evidencia/S1/capturas/navegador-conexion-segura.png)

**Verificación automática** (corre en el CI). Mismo script, misma acción y misma herramienta de captura contra el P2 y el P3
(`security-tests/s1_tls.py`; salidas, capturas `.pcap` y resúmenes en `docs/p3/evidencia/S1/antes` y
`docs/p3/evidencia/S1/despues`):

```text
$ python security-tests/s1_tls.py --evidence docs/p3/evidencia/S1/despues
OK   HTTP GET /login redirige a HTTPS — 301 → https://localhost:8443/login
OK   HTTP POST /api/auth/login redirige a HTTPS — 301 → https://localhost:8443/api/auth/login
OK   TLS 1.3 negociado y certificado válido para el host — TLSv1.3 TLS_AES_256_GCM_SHA384
OK   TLS 1.2 admitido (clientes antiguos) — TLSv1.2 ECDHE-ECDSA-AES256-GCM-SHA384
OK   TLS 1.0 rechazado por el gateway — TLSV1_ALERT_PROTOCOL_VERSION
OK   TLS 1.1 rechazado por el gateway — TLSV1_ALERT_PROTOCOL_VERSION
OK   cabecera Strict-Transport-Security — max-age=300
OK   sesión de prueba completa (tablero y mensaje de chat creados) — tablero HTTP 201, mensaje HTTP 201
OK   login por la web: cookie de sesión Secure; HttpOnly; SameSite — Secure; HttpOnly; SameSite=lax
OK   WebSocket Pixels por wss:// — wss:// → HTTP/1.1 101 Switching Protocols
OK   WebSocket Chat con cookie por wss:// — wss:// → HTTP/1.1 101
OK   captura de red: 0 secretos legibles — correo: 0, contraseña: 0, JWT de sesión: 0, mensaje de chat: 0
Todas las comprobaciones OK
```

![Captura antes y después](../evidencia/S1/s1-captura-antes-despues.png)

En la captura del P3 (`despues/s1-flujo-tcp.txt`) solo aparecen *ClientHello*/*ServerHello* con
TLS 1.3 (`0x0304`) y registros cifrados; el único HTTP en claro es el `GET /healthz` interno del
*healthcheck* del contenedor.

| Medida de la respuesta | P2 (antes) | P3 (después) |
|---|---|---|
| Secretos legibles en la captura de una sesión completa (correo, contraseña, JWT, mensaje) | 3 + 3 + 4 + 2 | **0** |
| HTTP plano (`:8088`) | sirve la aplicación | **301 → HTTPS** (también el `POST` de login) |
| TLS 1.0 / 1.1 | no hay TLS | **rechazados** (`protocol_version`) |
| Versión negociada por un cliente actual | — | **TLS 1.3** |
| `Strict-Transport-Security` | ausente | `max-age=300` (producción: `31536000`) |
| Cookie `cb_session` | `HttpOnly; SameSite=lax` | **`Secure`**; `HttpOnly`; `SameSite=lax` |
| WebSocket (Pixels, Chat) | `ws://` | **`wss://`** (101) |
| Rutas de la web y las APIs por HTTPS | 0 % | **100 %**: `sh scripts/gateway_smoke.sh https://localhost:8443` → 23/23 OK |

Regresión (el sistema sigue funcionando por HTTPS): `node scripts/ws_check.mjs https://localhost:8443`
→ 14/14 OK; E2E con navegador real (`WEB_SSR_URL=https://localhost:8443 pytest e2e/test_web_ssr.py
e2e/test_notifications.py`) → 4/4, incluida la comprobación nueva de la cookie `Secure`; contrato del
gateway (`gateway/tests/contract.test.mjs`) → 50/50, con tres casos nuevos (redirección, HSTS y versiones
de TLS); `rabbit-smoke` OK. Todo esto corre en el CI (`.github/workflows/ci.yml`).

**Qué protege y qué no.** Protege el tramo expuesto (navegador o pixels-ui ↔ gateway) contra lectura
y alteración, y autentica al servidor. No protege el tramo interno gateway → servicios (HTTP dentro de
la red `internal`, sin puertos publicados; su aislamiento es S3), ni el primer acceso por
`http://` de un navegador que nunca vio la cabecera HSTS (lo mitigaría la lista *HSTS preload* con un
dominio real), ni un equipo cliente comprometido.

### 7. Cambios en las vistas

Archivos (`.drawio` editable + `.png`): `docs/p3/diagramas/vista-cc.S1`, `vista-despliegue.S1`,
`vista-capas.S1` y `vista-descomposicion.S1`; el detalle de cada cambio está en
`docs/p3/diagramas/CAMBIOS-S1.md`.

![Vista C&C con S1](../diagramas/vista-cc.S1.png)

- **C&C:** los conectores Browser → gateway y pixels-ui → gateway pasan a `HTTPS / WSS :443` (TLS 1.2+);
  el gateway se anota con «secure channel» (terminación TLS, certificado, HSTS, `:80` → 301). Los
  conectores internos no cambian. Estilos: *Secure Channel* y *Gateway Offloading*.
- **Despliegue:** `gateway` publica `8443:443` (HTTPS/WSS) y `8088:80` (solo redirección); volumen
  `gateway/certs`; frontera de confianza entre el tramo cifrado (host cliente ↔ gateway) y el interno
  (red `internal`, HTTP).
- **Capas:** en la *Communication Tier*, dentro de `gateway`, el bloque «secure channel» (terminación TLS).
- **Descomposición:** subsistema *Gateway y trazabilidad* → `gateway (Nginx)` → módulo nuevo
  *Terminación TLS y certificados*.

### 8. Rendimiento: ¿cuánto cuesta TLS y cuánto se recupera?

Ficha completa, scripts y datos crudos en [`rendimiento/tls/`](../../../rendimiento/tls/README.md).

- **Hipótesis.** El costo de TLS está en el handshake (criptografía asimétrica), no en el cifrado de
  cada petición. Con conexiones reutilizadas (keep-alive) el sobrecosto en estado estable es pequeño.
- **Táctica / patrón.** *Reduce computational overhead* e *Increase resource efficiency* (reutilizar
  conexiones y sesiones, HTTP/2); *Gateway Offloading*.
- **Diseño.** Una variable por comparación, con los mismos límites (gateway 1 CPU; web-ssr, auth-api y
  collaboration-api 1 CPU cada uno), el limitador de tasa desactivado y k6 en la red `edge`.
  Configuraciones: A = HTTP (P2) · A′ = HTTP con conexión nueva · C = HTTPS keep-alive · B = HTTPS con
  handshake completo por petición · D = HTTPS keep-alive HTTP/2.
  Cargas: `GET /healthz` (solo gateway) a 500, 1500 y 3000 llegadas/s, y `GET /` (dashboard SSR) con
  5, 10 y 25 VUs. 60 s por nivel y 3 repeticiones en el nivel clave.

![Costo de TLS en /healthz](../../../rendimiento/tls/resultados/grafica-healthz.png)

| Comparación (una variable) | Resultado |
|---|---|
| A vs C · TLS en estado estable (`/healthz`, 1500/s) | p95 0,95 → 0,66 ms; CPU del gateway por petición 138 → 137 µs: **sin costo medible** |
| A′ vs B · costo del handshake (500/s) | CPU por petición 277 → 1178 µs (**4,3×**, ≈ 0,9 ms por handshake) |
| B a 1500 y 3000/s | gateway al **98 %**: se estanca en **~1220 req/s** (≈ 1200 handshakes/s por núcleo), p50 97 ms |
| B vs C · táctica *reutilizar conexiones* | **8× menos CPU** por petición (1178 → 147 µs) y sin cola |
| C vs D · HTTP/2 | −15 % de CPU a 1500/s; sin ventaja a 3000/s (k6 no multiplexa) |
| Dashboard SSR (10 VUs) | el cuello es web-ssr (100 % de CPU); HTTPS no empeora el p95 (A 570 ms, C 499 ms, D 346 ms) |

**Conclusión.** Con conexiones reutilizadas, TLS en el gateway no tiene costo medible. El riesgo es la
tasa de conexiones nuevas: ~1200 handshakes por segundo por núcleo. Por eso se mantienen keep-alive,
la caché de sesiones (`shared:SSL:10m`, `1d`), el certificado ECDSA y HTTP/2; para crecer, más CPU o
réplicas del gateway.

**Amenazas a la validez.** Una sola máquina, un portátil con núcleos híbridos. La red de Docker no
tiene RTT real, y en una LAN cada conexión nueva sumaría además un RTT por el handshake. P2 y P3 se
midieron en instancias distintas. k6 no reanuda sesiones TLS, así que B es el peor caso.
