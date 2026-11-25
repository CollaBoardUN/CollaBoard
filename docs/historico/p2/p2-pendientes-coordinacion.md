# Pendientes y coordinación del paquete F (gateway, despliegue y CI)

Qué asumí, qué variable cambiar cuando llegue el servicio real y qué observé en código ajeno
(**no lo modifiqué**: se anota para su dueño). Fecha: 2026-10-28.

## 1. Pendientes por compañero

### David y Marlon · autenticación del WebSocket de Pizarra (cookie vs Bearer)
- **Hoy:** `/ws/boards/{id}` solo lee `?token=` (`pizarra-backend/app/routers/ws.py`). El navegador solo tiene la cookie HttpOnly `cb_session`
  y otros clientes pueden enviar `Authorization: Bearer`.
- **Asumí:** el gateway traduce cookie/Bearer → `?token=` **solo hacia Pizarra** (`PIZARRA_WS_TOKEN_QUERY=on`); los clientes nunca ponen el token en la URL.
  Verificado: Bearer y cookie conectan (`sync` recibido), sin credencial → cierre `4401`.
- **Cuando Pizarra lea cabecera/cookie:** `PIZARRA_WS_TOKEN_QUERY=off` en `.env` (sin tocar el gateway). Validar `Origin` si usan la cookie (Chat ya lo hace).
- ⚠ **Seguridad:** mientras `on`, el *access log* de uvicorn de Pizarra imprime la URL con el JWT (`"WebSocket /ws/boards/<id>?token=<jwt>"`, confirmado en los logs).
  Acción sugerida para Pizarra: aceptar `Authorization`/cookie, o ejecutar uvicorn con `--no-access-log`/filtro. El log del gateway **no** guarda la query.

### Cristian · NotificationAPI, worker y RabbitMQ
| Tema | Asumí | Variable / archivo a cambiar |
|---|---|---|
| Servicio HTTP | `notification-api:8080`, rutas `/api/notifications` y `/api/notifications/{id}/read`, eventos en `POST /internal/events` | `NOTIFICATION_API_UPSTREAM`, `NOTIFICATION_API_PATH_PREFIX` (`.env`) |
| Reemplazo de stubs | mismos nombres de servicio (`notification-api`, `message-worker`), red `internal` | quitar `docker-compose.stubs.yml` de `COMPOSE_FILE` y definir ambos con `build:` a `notifications-module/` (ver ADR 0004) |
| Broker | vhost `collaboard`, exchange `notifications.events` (direct), cola quorum `notifications.tasks` (routing key `notification.task`), DLQ `notifications.tasks.dlq`, 3 entregas | `RABBITMQ_*` en `.env` (**nombres provisionales: decide Cristian**) |
| Usuarios AMQP | API: `notification_api` (solo publica en el exchange); worker: `message_worker` (solo lee la cola); ninguno declara topología | `RABBITMQ_NOTIFICATION_API_*`, `RABBITMQ_MESSAGE_WORKER_*` |
| Conexión | `amqp://<usuario>:<pwd>@rabbitmq:5672/collaboard` | inyectar por `environment:` al definir los servicios reales |
| Base | `notification-db` (PostgreSQL, usuario/base de `NOTIFICATION_DB_*`) | `.env` |
| Identidad de servicio | `X-Service-Token` = `NOTIFICATIONS_SERVICE_TOKEN` (así lo usan Chat y el mock) | `.env` |

Si el broker necesita otra topología (p. ej. que el productor la declare), cambiar `rabbitmq/definitions.template.json` y recrear el volumen `rabbitmq_data`.
Pendiente para la prueba del plan «detener el worker, acumular, reiniciar»: hoy solo está demostrada la parte de infraestructura (`scripts/rabbit_recovery.py`),
no el consumo idempotente (el worker es un stub).

### Marlon · Chat (Java)
- **Asumí:** `chat-api:8090`; rutas `/api/chat/boards/{id}/messages` y `/ws/chat/boards/{id}` **sin reescritura**; base `chat` en MongoDB con usuario `chat`;
  permisos vía `COLLABORATION_URL=http://collaboration-api:8000` y `COLLABORATION_BOARDS_PATH=/boards` (ruta actual de Colaboración, no el endpoint interno futuro de David);
  eventos a `NOTIFICATIONS_URL=http://notification-api:8080`. Cambiar con `CHAT_API_UPSTREAM` (gateway) y las variables de `chat-api` en `docker-compose.yml`.
- **Observado:** las pruebas Maven requieren `TEST_MONGODB_URI` (si no, 15/17 fallan por `IllegalStateException`); con una MongoDB desechable pasan 17/17. La CI ya lo provee.
- **Observado:** el cliente HTTP de Chat (JDK) envía `Upgrade: h2c` en HTTP plano. El mock de Notificaciones (Node, `web-ssr/dev/mocks`) lo trata como un upgrade inválido y
  **resetea la conexión**, así que los eventos de Chat quedaban pendientes (`ResourceAccessException`) para siempre. Mitigación mía solo en pruebas: Nginx delante del mock
  (`docker-compose.notifications-mock.yml`). Conviene que Chat fuerce HTTP/1.1 (`HttpClient.Version.HTTP_1_1`) para no depender del servidor de Notificaciones.

### David · Colaboración, permisos y datos
- **Endpoint interno de acceso** (`GET /internal/boards/{id}/access`): no existe; el gateway ya lo oculta (404 en cualquier prefijo `internal`).
- **Pizarra y su copia del CRUD:** `pizarra-api` apunta a `canvas-db` (separada), pero todavía consulta tableros/miembros por SQL en sus propias tablas, por lo que **un tablero creado en
  Colaboración no es visible para Pizarra** (el WS cierra `4403`). Para el recorrido completo usé `docker-compose.compat-shared-db.yml`, que apunta Pizarra a `board-db`.
  **Transitorio:** quitarlo cuando Pizarra autorice por HTTP.
- **Observado en `colaboracion-module`:** `/health` devuelve `{"status":"ok","service":"colaboracion-module"}` pero los tests esperan `{"status":"ok"}` (`tests/test_auth.py::test_health`);
  hoy `pytest` da **17 fallos / 49 aciertos** (incluye `test_realtime.py`) y `ruff check` reporta E501 en `app/main.py:17`. El job `collaboration` de la CI es informativo (`continue-on-error`) hasta corregirlo.
- **Migración UserDB/BoardDB:** `user-db` y `board-db` nacen vacías; no migré datos del P1 (`pgdata`). Auth crea su esquema al arrancar y registrar usuarios funciona.

### Estefan · Pixels y CanvasDB
- Pixels usa MongoDB con usuario `pixels` y `authSource=collaboard_pixels` (ver ADR 0010); no tiene pruebas propias (la CI solo compila e importa). El E2E del recorrido pasa por `/api/pixels/*` y `/ws/pixels` del gateway (verificado: `board` 200, WS conecta).
- La UI de Pixels es opcional (`--profile pixels-ui`, http://localhost:3000) y apunta al gateway.
- `canvas-db` existe, vacía; la migración de Pizarra desde el P1 es de Estefan.

### Jhon · Web SSR
- Usa `GATEWAY_INTERNAL_URL=http://gateway:8081` (ADR 0002). `web-ssr/compose.dev.yml` y `web-ssr/dev/gateway/` pertenecen al flujo del P1 (`docker-compose.p1.yml`) y se pueden retirar cuando
  se dé por bueno el gateway real. Actualicé en sus README solo el nombre del archivo Compose del P1.
- Los 3 E2E de `e2e/test_web_ssr.py` **pasan** sobre el gateway nuevo (mock de Notificaciones detrás de Nginx).

## 2. Observaciones de infraestructura (mías)
- **X-Request-ID:** el gateway lo genera y lo escribe en su log (`rid=`); lo reenvían y registran Chat (`request_id=`) y el mock. Auth (Go), Colaboración, Pizarra y Pixels (Python) **no lo escriben en sus logs**;
  para que el flujo sea visible de extremo a extremo, cada dueño debería registrar la cabecera.
- **Auth (Go):** el `Dockerfile` hace `go mod download` con `-mod=mod` porque falta `go.sum` versionado (build no reproducible sin red).
- **Sin TLS** (ADR 0007).
- Los puertos/contraseñas por defecto son de desarrollo.
