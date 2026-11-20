# CONTEXTO S3 · Network Segmentation: qué cambió y qué deben tener en cuenta (léanlo antes de seguir)

Responsable: Stephan García · Rama: `p3/s3-segmentacion` · Detalle completo: [`fragmentos/S3-segmentacion-redes.md`](fragmentos/S3-segmentacion-redes.md)

## 1. Qué cambió, en una línea

La red plana `internal` ya no existe: ahora hay **7 redes internas con `internal: true`** (`app`, `net-user`, `net-board`, `net-canvas`, `net-notif`, `net-mongo`, `net-mq`) más la red `edge` (la única con puertos publicados al host).

## 2. Lo que tienen que tener en cuenta TODOS (y sus IAs al hacer merge/rebase)

1. **No vuelvan a poner `networks: [internal]`** en ningún compose ni override. Si algún archivo pide la red `internal`, Docker Compose falla al arrancar. Al hacer rebase de `docker-compose.yml`, conserven siempre los bloques `networks:` de S3.
2. **En qué red está cada servicio ahora:**
   - `edge` (`internal: false`): `gateway`, `pixels-ui`
   - `app` (`internal: true`): `gateway`, `web-ssr`, `auth-api`, `collaboration-api`, `pizarra-api`, `chat-api`, `pixels-api`, `notification-api`
   - `net-user` (`internal: true`): `auth-api`, `user-db`
   - `net-board` (`internal: true`): `collaboration-api`, `board-db`
   - `net-canvas` (`internal: true`): `pizarra-api`, `canvas-db`
   - `net-notif` (`internal: true`): `notification-api`, `message-worker`, `notification-db`
   - `net-mongo` (`internal: true`): `chat-api`, `pixels-api`, `pixels-nosqldb`
   - `net-mq` (`internal: true`): `notification-api`, `message-worker`, `rabbitmq`, `rabbit-smoke`
3. **Consola de RabbitMQ (`127.0.0.1:15672`) y puertos de bases en local:** como Docker no deja publicar puertos al host desde una red `internal: true`, moví `127.0.0.1:15672` a `docker-compose.dev-ports.yml`. Si necesitan abrir la consola de RabbitMQ o entrar con `psql`/`mongosh` desde su máquina, levanten añadiendo `-f docker-compose.dev-ports.yml`.
4. **Contenedores de prueba dentro de `app` o `net-*`:** esas redes no tienen Internet en runtime, así que no hagan `pip install` ni `npm install` dentro del `command:` al arrancar el contenedor (háganlo en un `Dockerfile` durante el `build`, como quedó en `scripts/Dockerfile.rabbit-smoke`).

## 3. Herramientas de prueba

| Herramienta | Cómo se usa |
|---|---|
| Escenario S3 (matriz TCP + sin Internet + redes) | `python security-tests/s3_segmentacion.py` (o `sh scripts/segmentation_check.sh`) |
| RabbitMQ smoke test (dentro de `net-mq`) | `docker compose stop message-worker && docker compose --profile tools run --rm rabbit-smoke && docker compose start message-worker` |
| Banco de rendimiento de `pixels-api` | `powershell -ExecutionPolicy Bypass -File rendimiento/pixels/run.ps1 all` y `python rendimiento/pixels/analizar.py` |

## 4. Por escenario: qué le toca a cada quien

| Escenario | Qué deben saber |
|---|---|
| **S1 · Secure Channel (Jhon)** | Ya está probado encima de S3 (`python security-tests/s1_tls.py` → 12/12 OK). El gateway queda en `networks: [edge, app]`. |
| **S2 · Reverse Proxy (Juan Sebastián)** | Si pasas `pixels-ui` detrás del gateway y le quitas el puerto `3000:80`, cámbiale la red de `edge` a `app` (y actualiza `EXPECTED_NETWORKS_P3` en `security-tests/s3_segmentacion.py`). Para tu prueba de escalado de `collaboration-api`, conecta k6 a `collaboard_edge`. |
| **S4 · Sesión JWT y RabbitMQ (Cristian)** | `auth-api` ya habla con `user-db` por `net-user`. Para tu prueba de rendimiento de notificaciones: si tu generador llama a `POST /internal/events` en `notification-api:8080`, conéctalo a `collaboard_app`; si consulta la API de RabbitMQ (`rabbitmq:15672`), conéctalo también a `collaboard_net-mq`. |
| **S5 · RBAC (David)** | `collaboration-api`, `pizarra-api` y `chat-api` comparten `app`, así que `/internal/boards/{id}/access` funciona directo. Si tu k6 mide ese endpoint interno directo sin pasar por el gateway, conéctalo a `collaboard_app`. |
| **S6 · Throttling y Pizarra (Marlon)** | `auth-api` ya tiene acceso a `user-db` en `net-user` para `login_attempts`. Para tu prueba de WS en `pizarra-api`, conecta k6 a `collaboard_edge`. |

## 5. Diagramas

- **Base de despliegue (mi entrega de línea base para el equipo):** `docs/p3/diagramas/base/vista-despliegue.base.drawio` (limpia, sin colores de escenarios y con las correcciones en gris del P2).
- **Las 4 vistas principales no cambian por S3:** como S3 solo segmenta las redes en Docker Compose y **no añade ni modifica ningún componente, contenedor, conector lógico, capa ni módulo de código**, las 4 vistas principales se dejan tal como están.
- **Subcarpeta explicativa (`docs/p3/diagramas/explicacion-S3/`):** ahí dejé todos los diagramas con anotaciones explicativas de las zonas de red (`vista-despliegue.S3`, `vista-cc.S3`, `vista-capas.S3`, `vista-descomposicion.S3`), el diagrama de secuencia (`secuencia-S3`) y el de la prueba de rendimiento (`vista-despliegue-perf-pixels`). Ver `docs/p3/diagramas/CAMBIOS-S3.md`.

## 6. Dónde está cada cosa

| Ruta | Qué es |
|---|---|
| `docker-compose.yml`, `notifications-module/compose.gateway.yml`, `docker-compose.stubs.yml`, `docker-compose.dev-ports.yml` | Definición de las 8 redes y asignación por contenedor |
| `scripts/Dockerfile.rabbit-smoke` | Imagen de `rabbit-smoke` con `pika` preinstalado para correr en `net-mq` sin Internet |
| `security-tests/s3_segmentacion.py`, `scripts/segmentation_check.sh` | Script que prueba todos los pares de la matriz, el bloqueo de salida a Internet y las redes |
| `docs/p3/evidencia/S3/antes/` y `despues/` | Resultados de la matriz en P2 y en P3 (`s3-resumen.json`, `s3-matriz.md`, `s3-salida.txt`) |
| `pixels-module/pixel-backend/src/` y `rendimiento/pixels/` | Agrupación WS cada 50 ms (`PIXELS_BATCH_INTERVAL_MS`) y banco de pruebas de rendimiento con k6 |
| `docs/adr/0013-segmentacion-de-redes-por-zonas.md` y `0019-rendimiento-pixels-ws-fanout.md` | ADRs de seguridad (S3) y de rendimiento (`pixels-api`) |
| `docs/p3/fragmentos/S3-segmentacion-redes.md` | Texto de S3 listo para pegar en el PDF final |

## 7. Resultados en una tabla

| | P2 / Baseline A | P3 / Variante B |
|---|---|---|
| Pares permitidos que funcionan | 22 / 22 | **22 / 22** |
| Saltos laterales a bases/broker ajenos bloqueados | 0 / 45 | **45 / 45** |
| Accesos `message-worker → app` bloqueados | 0 / 8 | **8 / 8** |
| Contenedores internos sin salida a Internet | 0 / 14 | **14 / 14** |
| Costo de segmentar (`GET /api/pixels/stats`, mediana `p50`) | 1,23 ms | **1,38 ms (+0,15 ms)** |
| `pixels-api` con 1000 clientes WS (`p95` / CPU / errores) | 12 624 ms / 98,7 % / 100 % | **137 ms / 38,5 % / 0,00 %** |
| `pixels-api` con 2000 clientes WS (píxeles escritos / errores) | 398 / 100 % | **23 348 (58,6×) / 0,00 %** |
