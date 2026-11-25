<div align="center">

**UNIVERSIDAD NACIONAL DE COLOMBIA — FACULTAD DE INGENIERÍA**<br>
Arquitectura de Software (2026-II) — Prof. Jeisson Andrés Vergara Vargas

# Guion y Guía de Sustentación — Prototipo 3

**CollaBoard · Equipo 1e**<br>
Resumen completo de arquitectura, seguridad (S1–S5), rendimiento y pruebas en vivo

</div>

---

## 1. Mapa rápido del sistema (para responder "¿cómo dockerizan y por qué esos contenedores?")

CollaBoard corre en **17 contenedores Docker** sobre **8 redes aisladas** con Docker Compose (rama `correciones-proxy-y-edge`, commit `68c3f90`).

### Por qué dockerizamos y por qué 17 contenedores
- **Stack políglota real (5 lenguajes de backend):** Go (`auth`), Python/FastAPI (`collaboration`, `pizarra`), Java/Spring Boot (`chat`), Rust/Axum (`pixels`), C#/.NET 8 (`notification`, `message-worker`), más Next.js 16 (`web-ssr`), React/Vite (`pixels-ui`) y dos contenedores Nginx (`reverse-proxy` y `gateway`). Docker garantiza reproducibilidad exacta sin conflictos de runtimes.
- **Un proceso independiente = un contenedor:**
  - **1 borde público (`reverse-proxy`):** único contenedor en la red `edge` y único que publica puertos al host (`8088→80` solo redirige a `8443→443` TLS 1.3). Aplica toda la política de borde S2 y reenvía páginas a `web-ssr`/`pixels-ui` y `/api/*` + `/ws/*` a `gateway`.
  - **1 API Gateway interno (`gateway`):** vive exclusivamente en la red interna `app` (sin salida a Internet ni puertos públicos). Enruta hacia las seis APIs, aplica límites por ruta de API/Auth/WS y atiende el canal interno `:8081` del BFF.
  - **2 frontends (`web-ssr`, `pixels-ui`):** ambos en la red interna `app` (sin exposición en `edge`); `web-ssr` maneja SSR, BFF y cookies `HttpOnly; Secure`; `pixels-ui` es la SPA servida detrás de `reverse-proxy` en `/pixels/`.
  - **6 APIs HTTP/WS (`auth`, `collaboration`, `pizarra`, `chat`, `pixels`, `notification`):** microservicios desacoplados por dominio.
  - **1 worker asíncrono (`message-worker`):** separado de `notification` para desacoplar RabbitMQ y **sacarlo de la red `app`** (principio de mínimo privilegio).
  - **5 bases de datos + 1 broker (`user-db`, `board-db`, `canvas-db`, `notification-db` en PostgreSQL 16; `pixels-nosqldb` en MongoDB 7; `rabbitmq`):** patrón **Database-per-Service**. Chat y Pixels comparten instancia MongoDB por RAM, pero con bases lógicas (`chat` y `collaboard_pixels`) y credenciales separadas (ADR 0013).
- **Buenas prácticas de contenedores:** imágenes ligeras (`alpine` / `slim`) con *multi-stage builds*, usuarios no-root, configuración 12-factor por `.env` y arranque ordenado con `healthchecks` (`depends_on: service_healthy`).

---

## 2. Resumen ejecutivo de los 5 escenarios de seguridad (S1–S5)

| # | Patrón y tácticas de Bass (§11.2) | Qué cambió de P2 a P3 | Resultado verificado (P2 → P3) |
|---|---|---|---|
| **S1** | **Secure Channel** (*Gateway Offloading*, *Encrypt Data*, *Verify Integrity*) | TLS 1.2/1.3 (ECDSA P-256) terminado en `gateway`, `:80` redirige 301, HSTS, cookies `Secure`, `wss://` | **12 → 0** secretos legibles (`s1_tls.py` 12/12; Wireshark 28/42/131/41 → **0/0/0/0**) |
| **S2** | **Reverse Proxy** (*Validate Input*, *Limit Access*, *Detect Service Denial*, *Audit*) | Lista blanca de rutas/métodos, validación de `Host` (421), saneado de `X-Forwarded-*`/`X-Service-Token`, límites por IP y tiempos, errores JSON propios, cierre de `:3000` | **9/41 → 41/41** ataques bloqueados; **28/28** rechazos con `us=-` (sin llegar al backend); **0/5** cabeceras falsificadas |
| **S3** | **Network Segmentation** (*Separate Entities*, *Limit Access*, *Limit Exposure*) | Red plana `internal` reemplazada por **8 redes**: `edge`, `app` y 6 redes `net-*` (una por almacén y una para RabbitMQ), las 7 internas con `internal: true`; `message-worker` fuera de `app` | **0/45 → 45/45** saltos a datos/broker bloqueados; **8/8** `worker → app` bloqueados; **14/14** sin salida a Internet; **22/22** permitidos OK |
| **S4** | **Token-Based Session** (*Authenticate Actors*, *Limit Exposure*, *Revoke Access*) | Access JWT reducido de 60 min a **≤ 15 min** con `jti`; refresh opaco rotatorio de un solo uso en `user-db`; reutilización revoca toda la familia; `POST /auth/logout` real (204) | Refresh reutilizado o tras logout: aceptado → **401**; `s4_sesion` **10/10** (11/11 TTL 5 s), `s4_web_refresh` **8/8** |
| **S5** | **RBAC + Authorizer (PDP/PEP) + Cache-Aside** (*Authorize Actors*, *Limit Access*, *Revoke Access*) | `POLICY_MATRIX` única (3 roles × 24 acciones) en `collaboration` (PDP); `pizarra` y `chat` son PEPs *fail-closed* con caché de 2 s y revalidación WS ≤ 5 s; 404 a no-miembros | **8 fallos → 144/144** celdas OK; revocación WS en **0,669 s / 0,559 s** (cierre `4403`); **−95 %** llamadas al PDP (20→1) |

*Nota clave para sustentar S3:* ¿Por qué 8 redes con `internal: true` en vez de `iptables` manuales? Porque es declarativo en Compose, verificable en CI (`s3_segmentacion.py`), dos contenedores no autorizados **ni siquiera comparten interfaz ni DNS** (`ServFail` / `Network unreachable`), y su costo de latencia es despreciable (`+0,15 ms`).

---

## 3. Resumen de resultados de rendimiento y qué significan

| Estudio | Configuración clave | Resultado principal | Cuello de botella y significado |
|---|---|---|---|
| **Consulta de tableros (`GET /api/boards`, §4.2.6)** | 1 CPU en `gateway`, `collaboration`, `board-db`; `sleep(1)`, `timeout=60 s`, 1→3 000 VUs | **Original:** bloqueo en **32 VUs** (`15/15 idle in tx`, 55,8 % timeouts, CPU 0,04 %). **Pool v2 (`25+25` + `rollback`):** techo **`113,8 req/s`**, 1ª rodilla **`150–300 VUs`** (CPU ~100 %), último nivel sin errores **`2 200 VUs`**, 2ª rodilla / quiebre **`2 400 VUs`** (`3,7 % → 16,8 %` en 3 000 VUs). Con **6 workers** sin tope: **`584,6 req/s`** (`35 078 TPM`) y 2 000 VUs sin pausa con 0 % error | **CPU de `collaboration`** ($D = 8,67\text{ ms/req} \Rightarrow X_{\max} \approx 115\text{ req/s}$). El `gateway` con TLS 1.3 no pasó del 17 % y `board-db` del 20 %. El patrón de seguridad NO es el cuello |
| **WebSocket de Pizarra (`wss://gateway/ws/boards/{id}`, §4.2.7)** | 1 CPU en `pizarra` y `gateway`; 20 editores reales; `ops→ack` + `cursor` cada 1 s; 10 s warmup + 30 s medición | **1 sala ($O(N^2)$):** óptimo **`50 VUs`** (`p95 = 210 ms`, 99,6 % `ack`), rodilla **`75 VUs`** (`8 281 msg/s`, CPU **99,2 %**, `p95 = 9,2 s`, 33,7 % sin `ack`), colapso `ack` en **≥ 130 VUs**. **Control 15 salas × 10 VUs (150 VUs):** confirmaciones suben de **0 % a 80,6 %** y fan-out baja **3,4×** (`8.643 → 2.542 msg/s`) | **Fan-out cuadrático $O(N^2)$ en el event loop de Python** (serialización JSON por cliente). Con `collaboration` sin fix de pool, el PDP se bloquea a 120 VUs y `pizarra` cumple *fail-closed* rechazando el 100 % |
| **WebSocket de Pixels (§4.2.3, ADR 0019)** | 1 CPU en `pixels` (Rust/Axum); 100→2 000 VUs; `batch=0 ms` vs `50 ms` | Rodilla sube de **< 500** a **1 000 VUs** (`p95 = 137 ms`, CPU 38,5 %, 0 % error); a 2 000 VUs escribe **58,6×** más píxeles (`23 348` vs `398`) | Táctica *micro-batching 50 ms* + `Arc<str>` reduce CPU/píxel de `5,14` a `2,01 ms` (`2,56×`) |
| **Costo de TLS (§4.2.2)** | `/healthz` a 1 500 r/s | Con keep-alive: **sin costo medible** (`138 → 137 µs/req`). Sin keep-alive: `4,3×` más CPU (~1 220 handshakes/s por núcleo) | Reutilizar conexiones gasta **8× menos CPU** |
| **Costo de S3 (§4.2.3)** | `GET /api/pixels/stats` a 1 500 r/s | `p50` pasa de `1,23 ms` (P2) a `1,38 ms` (P3) → **`+0,15 ms`** | Segmentar en 8 redes prácticamente no cuesta latencia |
| **Notificaciones (§4.2.5, ADR 0020)** | 1→8 workers; 10→50 ev/s | Escala de `4,2` a `19,4 ev/s`; rodilla en **20–25 ev/s**; recuperación DLQ **2 993/2 993** sin duplicados | *Competing Consumers* + *Queue-Based Load Leveling* |

---

## 4. Guion paso a paso para las pruebas en vivo en clase (5–7 minutos)

### Preparación 5 minutos antes de entrar
Asegúrate de estar en `main` con los 16 contenedores de `collaboard` saludables:
```powershell
docker compose -f docker-compose.yml -f notifications-module/compose.gateway.yml up -d --wait
```

### Paso 1 · Arquitectura Docker y Single Entry Point (45 s)
*Qué dices:* "Tenemos 16 contenedores por el stack políglota y Database-per-Service. Solo `gateway` publica puertos y las 7 redes internas tienen `Internal=true`."
```powershell
powershell -ExecutionPolicy Bypass -File ".\Pruebas en vivo\00-inspeccion-docker-arquitectura.ps1"
```
*Qué señalas en pantalla:* solo `collaboard-gateway-1` publica `:8088` y `:8443`; las 7 redes internas muestran `Internal=true`.

### Paso 2 · Prueba en vivo #1 — Ataque de movimiento lateral S3 (1 min)
*Qué dices:* "Simulamos un atacante que comprometió `pixels-api` e intenta conectarse a `user-db` (hashes de contraseñas) y exfiltrar a `1.1.1.1:443`."
```powershell
powershell -ExecutionPolicy Bypass -File ".\Pruebas en vivo\01-s3-segmentacion-ataque.ps1"
```
*Qué señalas en pantalla:* `user-db:5432` falla en DNS (`Try again`), `1.1.1.1:443` devuelve `Network unreachable`, pero `pixels-nosqldb:27017` abre (`succeeded`). Y `message-worker` no ve `auth-api:8001` pero sí `rabbitmq` y `notification-db`.

*(Si el profesor pide la matriz completa automatizada de los 89 caminos, toma ~60 s):*
```powershell
powershell -ExecutionPolicy Bypass -File ".\Pruebas en vivo\02-s3-matriz-completa.ps1"
```

### Paso 3 · Prueba en vivo #2 — Carga interactiva con `k6` pidiendo VUs al profesor (1–2 min)
*Qué dices:* "¿Con cuántos usuarios concurrentes quiere probar `pixels-api` en vivo? Podemos probar 500 o 1 000 VUs con el micro-batching de 50 ms."
```powershell
powershell -ExecutionPolicy Bypass -File ".\Pruebas en vivo\03-perf-pixels-ws.ps1"
```
*(El script pregunta en consola cuántos VUs, el batch `0` o `50` ms y los segundos; también puedes usar `04-perf-segmentacion-http.ps1` para HTTP o `05-perf-boards.ps1` para `/api/boards`.)*

### Paso 4 · Mostrar evidencias y gráficas ya medidas (1 min)
```powershell
powershell -ExecutionPolicy Bypass -File ".\Pruebas en vivo\06-resumen-pruebas-previas.ps1" -AbrirGraficas
```
Además ten abiertas las gráficas principales de:
- `Entrega-Rendimiento-P3/graficas/figura-3-rodilla-y-quiebre-boards-p3.png` (1→3 000 VUs, rodilla 300, quiebre 2 400 VUs).
- `Entrega-WebSocket-Pizarra-P3/graficas/figura-1-rodilla-y-quiebre-pizarra-ws.png` y `figura-2-una-sala-vs-multisala.png` (óptimo 50, rodilla 75, control 15 salas).

### Respaldo rápido si el profesor pregunta por S1, S2, S4 o S5
| Escenario | Evidencia lista para mostrar | Comando en vivo (si lo pide) |
|---|---|---|
| **S1 · Secure Channel** | `docs/p3/evidencia/S1/wireshark/s1-wireshark-antes-despues.png` | `python security-tests/s1_tls.py` |
| **S2 · Reverse Proxy** | `docs/p3/evidencia/S2/` y `security-tests/s2_catalogo.md` (41/41) | `node security-tests/s2_proxy.mjs --target https://localhost:8443 --ca gateway/certs/ca.crt` |
| **S4 · Sesión / Refresh** | `docs/p3/evidencias/s4/` (10/10 y 8/8) | `node security-tests/s4_sesion.mjs` |
| **S5 · RBAC (PDP/PEP)** | `docs/p3/evidencia/S5/despues/s5-matriz.md` (144/144 celdas) | `python security-tests/s5_rbac.py --mode inprocess` |

---

## 5. Preguntas frecuentes del profesor y respuestas rápidas

1. **¿Por qué elevaron el rate limit del gateway en las pruebas de rendimiento?**
   Porque en `k6` todos los VUs salen de **una sola IP**; sin elevarlo estaríamos midiendo el limitador de Nginx (`30 r/s`) y no la capacidad real del backend. Se hace solo en el override de prueba sin tocar el código.
2. **¿Por qué en `GET /api/boards` la latencia sigue creciendo después de la rodilla sin dar errores hasta 2 400 VUs?**
   Porque una vez corregido el pool (`50` conexiones > `40` hilos), ningún hilo se bloquea; al saturarse la CPU de `collaboration` (~114 req/s), las peticiones simplemente hacen cola según Little ($R \approx N/X - 1\text{ s}$) hasta que a **2 400 VUs** la cola supera el timeout de `60 s`.
3. **¿Por qué `pixels` (Rust) aguanta 1 000 VUs en 1 sala y `pizarra` (Python) satura en 75 VUs?**
   Dos razones combinadas: (1) `pixels` ya tiene **micro-batching de 50 ms + `Arc<str>`** (serializa una sola vez por ventana) y corre en Rust/Tokio, mientras `pizarra` corre en un event loop de Python serializando JSON por cada cliente bajo `room.lock`; (2) en nuestra prueba de `pizarra` cada usuario enviaba `ops` + `cursor` cada `1 s` (5× más frecuente que el cooldown de `5,2 s` de `pixels`).
4. **¿Por qué separaron `reverse-proxy` y `gateway` en dos contenedores y sacaron `pixels-ui` de `edge`?**
   Para alinear al 100 % el despliegue real con el criterio de componente en tiempo de ejecución y reforzar la segmentación de borde: ahora **solo `reverse-proxy` vive en `edge`** (único contenedor con salida al host/Internet), mientras `gateway` (API Gateway interno) y `pixels-ui` quedan aislados dentro de la red `app` (`internal: true`).
