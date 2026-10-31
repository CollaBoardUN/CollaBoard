# Integración de tu código C# con la rama de Sebastian

Inspeccionado: `gateway/nginx-rabbitmq` del repositorio `CollaBoardUN/CollaBoard`.
Su infraestructura ya tiene RabbitMQ con *vhost* `collaboard`, exchange `notifications.events`,
cola QUORUM `notifications.tasks`, `notifications.dlx` y DLQ `notifications.tasks.dlq`.
Hay cuentas AMQP con permisos diferentes: la API **solo publica**; el worker **solo consume**.

Tu código se adapta mediante `RABBITMQ_MANAGED_TOPOLOGY=true`: **no declara colas**
ni exchanges y usa confirmación de publicación, ack después de commit y `BasicNack(requeue:true)`.
La cola QUORUM aplica `x-delivery-limit=2` (= tres entregas totales), después DLQ.
No se requieren credenciales admin en ninguna API.

**El servicio en el gateway final** se llama `notification-api` (puerto interno **8080**),
y el worker `message-worker`. El archivo `compose.gateway.yml` implementa exactamente esos nombres.
La ruta pública `/api/notifications` ya está configurada en su Nginx. Chat envía a
`http://notification-api:8080/internal/events`, sin cambio al código Java.

En la **rama de Sebastian** (después de integrar los demás paquetes):

```bash
# NO cargar docker-compose.stubs.yml. Usa -f explícitos.
docker compose -f docker-compose.yml -f notifications-module/compose.gateway.yml config --quiet
docker compose -f docker-compose.yml -f notifications-module/compose.gateway.yml up --build -d
```

Para pruebas `smoke.py` sin hacer públicos los eventos internos:

```bash
docker compose -f docker-compose.yml \
  -f notifications-module/compose.gateway.yml \
  -f notifications-module/compose.gateway.debug.yml up --build -d
python3 notifications-module/scripts/smoke.py
```

En este modo, la API queda publicada **solo** en `127.0.0.1:4100` con puerto
interno 8080. Para producción, quitar el overlay `compose.gateway.debug.yml`.

**No uses `compose.notifications.yml` junto con el Compose de Sebastian**:
ese archivo está diseñado exclusivamente para la rama `Tiempo_real-y-chat`,
donde todavía no existe el gateway definitivo, RabbitMQ ni NotificationDB.

## Integración del evento de David

En la rama `Colaboración-permisos-e-identidad`, David ya implementó
`enqueue_invite_accepted()` en `colaboracion-module/app/outbox.py` con **el mismo**
contrato (incluyendo `event_id`, tipo, actor, destinatario owner y payload).
Su `config.py` usa `NOTIFICATIONS_URL` y `INTERNAL_SERVICE_TOKEN` (con fallback al
`NOTIFICATIONS_SERVICE_TOKEN`). El overlay de Sebastian añade explícitamente:

- `NOTIFICATIONS_URL=http://notification-api:8080`
- `INTERNAL_SERVICE_TOKEN=${NOTIFICATIONS_SERVICE_TOKEN}`

Así, al integrar su rama no se enviarán invitaciones por error al puerto
predeterminado 8085 de su desarrollo independiente. **No copies ni reescribas**
`outbox.py`: el productor y sus reintentos pertenecen a David.
