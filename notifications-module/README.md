# CollaBoard P2 · Cristian · Notifications C# + RabbitMQ

**Base de integración:** rama `Tiempo_real-y-chat`.

## Contratos reales consumidos

- Chat Java ya persiste su propio evento `chat.message.created` y lo reenvía con el MISMO `event_id` hacia `POST /internal/events`, header `X-Service-Token`. Se conserva intacto.
- La bandeja Next.js de Jhon ya consume `GET /api/notifications?limit=20` y `PATCH /api/notifications/{id}/read`. Se conserva intacta.
- `X-Request-Id` se devuelve; errores JSON como `{ "detail": "..." }`.
- JWT firmado con HS256 por Go, issuer `collaboard-auth`, claim `sub` como usuario.

## Arquitectura

```text
Chat Java / Colaboración Python ─HTTP interno POST /internal/events─> NotificationAPI C# :4100
                                                                      │
                                                                      ▼
                                                NotificationDB PostgreSQL
                                             [notification_events + outbox]
                                                                      │
                                                  Dispatcher C# (publisher confirms)
                                                                      │ AMQP persistent
                                                                      ▼
                                                                RabbitMQ
                                                    cola QUORUM + DLX + DLQ
                                                                      │
                                              worker C# (manual ack after COMMIT)
                                                                      │
                                                                      ▼
                                               notifications UNIQUE(event_id, recipient_id)
                                                                      ▲
                                                         HTTP GET/PATCH │
                                       Web SSR NotificationBell → Gateway → NotificationAPI
```

API y worker son dos **procesos y contenedores separados**. NotificationDB es una instancia PostgreSQL propia, no la DB de tableros. RabbitMQ **no es una base de datos**. API no consulta ni modifica ChatDB/BoardDB.

## Instalación sin sobrescribir al equipo

Desde la raíz del repo, con la rama `Tiempo_real-y-chat` actualizada y una **rama personal** nueva:

```bash
git fetch origin
git switch -c feat/notifications-csharp origin/Tiempo_real-y-chat
# Descomprime y copia notifications-module/ en la raíz.
python3 notifications-module/scripts/install_gateway.py .
```

Agrega al `.env` de la raíz (sin cambiar el `JWT_SECRET` compartido):

```bash
python3 - <<'PY'
import secrets
for name in ('NOTIFICATION_DB_PASSWORD','RABBITMQ_PASSWORD','NOTIFICATIONS_SERVICE_TOKEN'):
    print(name+'='+secrets.token_urlsafe(36))
PY
```

Pega cada valor generado en `.env`. Evita duplicar claves existentes y no compartas su contenido. `NOTIFICATIONS_SERVICE_TOKEN` debe coincidir en Chat Java, NotificationAPI y eventualmente Colaboración. El Compose overlay lo configura para Chat.

```bash
docker compose -f docker-compose.yml -f web-ssr/compose.dev.yml -f notifications-module/compose.notifications.yml config --quiet
docker compose -f docker-compose.yml -f web-ssr/compose.dev.yml -f notifications-module/compose.notifications.yml up --build -d
docker compose -f docker-compose.yml -f web-ssr/compose.dev.yml -f notifications-module/compose.notifications.yml ps
curl -fsS http://localhost:4100/health
```

Web: `http://localhost:8088`, RabbitMQ Management: `http://localhost:15672` (user `collaboard`, contraseña de `.env`). Los puertos del proyecto original **no se cambian**; API 4100 se expone solo en loopback para la demo, nunca `/internal/*` por el gateway. `dev-mocks` puede seguir ejecutándose por dependencias de desarrollo, pero ni Chat ni la bandeja lo usan para notificaciones bajo este overlay.

## Pruebas funcionales

```bash
python3 notifications-module/scripts/smoke.py
```

La prueba crea dos cuentas de prueba, envía un evento duplicado, comprueba una sola notificación, exclusion del actor, 404 para la otra cuenta y marcado de lectura del destinatario.

### Demostrar recuperación (trabajador detenido)

1. `docker compose -f docker-compose.yml -f web-ssr/compose.dev.yml -f notifications-module/compose.notifications.yml stop notification-worker`
2. En la web envía un mensaje de Chat Java con dos usuarios en un tablero: el mensaje debe guardarse y el outbox enviarse al broker. La bandeja del receptor aún no recibe el aviso.
3. `docker compose -f docker-compose.yml -f web-ssr/compose.dev.yml -f notifications-module/compose.notifications.yml start notification-worker`
4. Abre la bandeja del receptor; debe llegar una notificación sin duplicación.

### Demostrar broker detenido

1. Detener `rabbitmq` con Compose tras iniciar los servicios.
2. Mandar un nuevo mensaje: Chat confirma la acción, API retorna `202` si NotificationDB está disponible, el outbox no marca el evento como publicado.
3. Arrancar `rabbitmq` otra vez. El dispatcher retoma el evento pendiente; el worker entrega.

### Duplicados y DLQ

- Repetir `POST /internal/events` con mismo `event_id` y contenido devuelve `202` con `duplicate:true`; contenido distinto devuelve `409`.
- El worker hace `INSERT ... ON CONFLICT (event_id,recipient_id) DO NOTHING` y `BasicAck` después de COMMIT. La cola QUORUM redirige a DLQ al superar tres entregas sin ack (x-delivery-limit=2). En caída persistente de DB, los eventos pueden quedar en DLQ y requieren reenvío operativo; no se promete exactly-once.
- Cola QUORUM durable + mensajes persistentes + publisher confirms; hay ventana de doble entrega y es **intencional**: DB impide duplicados visibles.

## Para David y Marlon

Contrato para ambos:

```http
POST http://notification-api:4100/internal/events
X-Service-Token: <NOTIFICATIONS_SERVICE_TOKEN>
Content-Type: application/json
```

```json
{
  "event_id": "evt-001",
  "type": "invite.accepted",
  "occurred_at": "2026-10-30T12:00:00Z",
  "actor_id": "uuid-usuario-que-acepta",
  "board_id": "uuid-tablero",
  "recipient_ids": ["uuid-owner"],
  "payload": {"board_name":"Arquitectura P2","actor_name":"Ana","role":"editor"}
}
```

**202** significa persistido y pendiente de publicación, NO entregado. Reintentos del emisor usan el mismo `event_id`. Chat Java ya hace esto; David aún debe conectar `invite.accepted` tras la aceptación real de invitaciones.

## Límites y seguridad

- El gateway solo expone los GET/PATCH de bandeja. `POST /internal/events` se autentica con token de servicio; en la demo local el puerto 4100 se expone solo en `127.0.0.1` para pruebas; quitar ese puerto en producción.
- JWT obligatorio para bandeja; el sujeto (`sub`) determina destinatario, nunca una cabecera o parámetro del cliente.
- No usa correos ni push de SO. Solo notificaciones dentro de CollaBoard.
- No se ha ejecutado un build .NET ni pruebas de integración RabbitMQ/DB en este entorno; ejecutarlas con Docker. Mantener el módulo en rama independiente hasta pasar CI y revisar con Sebastian.

### Comprobación C# sin PostgreSQL/RabbitMQ

```bash
# Si tienes .NET SDK 8 local:
dotnet run --project notifications-module/src/Notification.Checks

# O desde Docker, sin instalar .NET en Ubuntu:
docker run --rm -v "$(pwd)/notifications-module:/src" -w /src \
  mcr.microsoft.com/dotnet/sdk:8.0 dotnet run --project src/Notification.Checks
```

Se comprueban tipos de evento admitidos, payload, usuario y validación de destinatarios. La prueba de integración real se hace con `smoke.py` y los contenedores.

## Integración definitiva con Sebastian

La rama `gateway/nginx-rabbitmq` tiene infraestructura real distinta del Compose
transitorio de la rama `Tiempo_real-y-chat`. **No es necesario copiar un segundo
RabbitMQ**: se proporciona `compose.gateway.yml` que utiliza su instancia, su DB,
su vhost, cola QUORUM y las dos identidades de AMQP con mínimo privilegio.
Lee [INTEGRACION_SEBASTIAN.md](INTEGRACION_SEBASTIAN.md) antes del merge.
