# Guía de Sustentación en Vivo · Docker, Segmentación S3 y Rendimiento

Esta guía resume exactamente las preguntas que suele hacer el profesor en clase y qué responder con evidencia real.

---

## 1. ¿Cómo dockerizan, por qué ese método y por qué esos 16 contenedores?

- **Por qué Docker + Docker Compose:** el sistema es **políglota** (5 lenguajes de backend: Go, Python/FastAPI, Java/Spring, Rust/Axum, C#/.NET 8, más Next.js/Node y Nginx). Docker garantiza entornos reproducibles sin conflictos de versiones de runtimes ni dependencias en el host.
- **Por qué esos 16 contenedores (1 proceso independiente = 1 contenedor):**
  - **1 borde (`gateway`, Nginx 1.27):** único punto de entrada (`:8088` redirige a `:8443` TLS 1.2/1.3). Aplica Reverse Proxy + API Gateway en un solo proceso.
  - **2 frontends (`web-ssr` Next.js + `pixels-ui` React/Vite):** separados porque `web-ssr` es SSR/BFF con manejo de cookies `HttpOnly` y `pixels-ui` es una SPA estática servida en `/pixels/`.
  - **6 APIs HTTP/WS (`auth-api`, `collaboration-api`, `pizarra-api`, `chat-api`, `pixels-api`, `notification-api`):** microservicios por dominio acotado, escalables y desplegables de forma independiente.
  - **1 worker asíncrono (`message-worker`):** separado de `notification-api` para desacoplar el consumo de RabbitMQ y **sacarlo completamente de la red `app`** (principio de mínimo privilegio).
  - **5 bases de datos + 1 broker (`user-db`, `board-db`, `canvas-db`, `notification-db` en PostgreSQL 16; `pixels-nosqldb` en MongoDB 7; `rabbitmq`):** patrón **Database-per-Service**; cada servicio solo ve su almacén (y en MongoDB, `chat` y `collaboard_pixels` usan bases lógicas y credenciales separadas para ahorrar RAM, documentado en ADR 0013).
- **Buenas prácticas de dockerización aplicadas:**
  - **Multi-stage builds** e imágenes ligeras (`alpine` / `slim`), usuarios no-root (`appuser`), configuración por entorno (12-factor `.env`) y arranque ordenado con **`healthchecks` + `depends_on: service_healthy`**.
  - **Un solo contenedor con puertos publicados (`gateway`)**: en el P2 también se publicaba `pixels-ui (:3000)`; en P3 se cerró y los puertos de depuración solo existen en el override `docker-compose.dev-ports.yml` (atados a `127.0.0.1`).

---

## 2. ¿Por qué segmentación con 8 redes Docker (`internal: true`) y qué tácticas aplicaron?

- **Tácticas de seguridad (Bass, §11.2):**
  1. **Separate entities:** una red dedicada por almacén (`net-user`, `net-board`, `net-canvas`, `net-notif`, `net-mongo`) y una para el broker (`net-mq`), más `app` (tráfico HTTP entre servicios) y `edge` (única zona con salida al host).
  2. **Limit access:** cada contenedor solo se adjunta a las redes que estrictamente necesita; `message-worker` queda fuera de `app`.
  3. **Limit exposure:** las 7 redes internas tienen `internal: true`, lo que bloquea salida a Internet y publicación de puertos a nivel de red Docker.
- **Por qué este método y no reglas `iptables` manuales dentro de cada contenedor:**
  - Con `internal: true` + redes separadas, dos contenedores no autorizados **ni siquiera comparten interfaz de red ni resolución DNS** (`ServFail` en DNS, `Network is unreachable` hacia Internet). Es declarativo en `docker-compose.yml`, versionable, verificable en CI (`s3_segmentacion.py`) y casi sin costo de latencia (`+0,15 ms`).

---

## 3. ¿Qué tácticas de rendimiento aplicaron y por qué dieron esos resultados?

### A) `pixels-api` WebSockets (ADR 0019)
- **Tácticas:** *Introduce concurrency* (Tokio async), *Bound queue sizes* (`broadcast::channel(4096)` sin desconectar ante `Lagged`), *Reduce computational overhead* (**micro-batching de 50 ms** + serialización única a `Arc<str>`).
- **Por qué falla el Baseline (`0 ms`) en 1 000 VUs y qué significa:**
  - Con 1 000 clientes mandando un píxel cada `5,2 s` entran `~192 px/s`. En Baseline cada tarea receptora serializaba su propio JSON (`N` serializaciones por píxel): cada píxel costaba **`5,14 ms` de CPU** (`D = U / X = 0,987 / 192`). Con 1 CPU el techo es `194 px/s`, así que en 1 000 VUs se satura al **98,7 % CPU**, se llena el buffer de 4 096 mensajes (`RecvError::Lagged`) y el bucle cierra el socket al **100 % de los clientes** (`p95 = 12,6 s`).
- **Por qué mejora la Variante (`50 ms`) y qué significa:**
  - Al agrupar píxeles cada `50 ms` y serializar una sola vez a `Arc<str>`, el costo baja a **`2,01 ms` de CPU por píxel** (`2,56×` menos). Por la **Ley de Utilización**, el techo sube a `~498 px/s` (`~2 590 VUs`). Por eso a **1 000 VUs** la CPU queda en **38,5 %**, `p95 = 137 ms < 250 ms` y **0,00 % errores** (y a **2 000 VUs** llega al 99 % CPU pero con **0,00 % errores** y **58,6× más píxeles escritos**).
  - *Trade-off:* cuando el sistema está vacío añade hasta `50 ms` de espera, a cambio de no caerse bajo carga alta.

### B) Costo de la segmentación S3 (`GET /api/pixels/stats` a 1 500 req/s)
- **Resultado:** `p50` pasa de **`1,23 ms`** (red plana P2) a **`1,38 ms`** (8 redes P3) → **`+0,15 ms`**, `0 %` errores.
- **Qué significa:** aislar en 8 zonas Docker no penaliza la latencia mediana de manera apreciable en operación normal; el salto de seguridad (45/45 saltos bloqueados + 14/14 sin Internet) prácticamente sale "gratis" en latencia.

### C) `GET /api/boards` (estudio principal)
- **Por qué colapsó `Original` en 32 VUs:** pool por defecto de SQLAlchemy (`5+10 = 15` conexiones) sin `db.rollback()` explícito → las 15 conexiones quedaron `idle in transaction`, la CPU cayó a `0,04 %` (inanición) y 55,8 % terminaron en timeout.
- **Al aplicar `Pool` (`25+25` + `rollback()`) + 6 workers sin tope de CPU/RAM:** pasó de 152 TPM a **32 120 TPM en 32 VUs** y aguantó hasta **2 000 VUs sin pausa con 0 % errores** (**35 078 TPM**, `p95 = 4,7 s`).

---

## 4. Secuencia recomendada para la demo en clase (5 min)

1. **`00-inspeccion-docker-arquitectura.ps1`** (30 s) → Enseñas los 16 contenedores, que solo `gateway` publica puertos y las 8 redes con `Internal=true`.
2. **`01-s3-segmentacion-ataque.ps1`** (45 s) → Ataque en vivo desde `pixels-api` y `message-worker` (o **`02-s3-matriz-completa.ps1`** para los 89 caminos).
3. **`03-perf-pixels-ws.ps1`** (1–2 min) → Le preguntas al profe *"¿Con cuántos VUs quiere que la corramos en vivo? ¿500 o 1000?"*, metes el número en consola y muestras el resultado en vivo.
4. **`06-resumen-pruebas-previas.ps1 -AbrirGraficas`** (30 s) → Cierras mostrando las gráficas comparativas ya generadas (P2 vs P3).
