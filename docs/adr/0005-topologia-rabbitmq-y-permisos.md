# ADR 0005 · Topología de RabbitMQ y permisos

- **Estado:** aceptada (nombres de cola **provisionales**) · **Fecha:** 2026-10-28 · **Paquete:** F (infraestructura) con Cristian (lógica)

## Contexto
El plan define NotificationAPI → RabbitMQ → MessageWorker (C07): cola durable, publicación confirmada, consumo con
ack manual, reintentos limitados (3) y DLQ. La lógica (outbox, idempotencia, consumidor) es de Cristian; aquí solo la infraestructura.

## Decisión
`rabbitmq/` construye una imagen sobre `rabbitmq:3.13-management-alpine`. `render-definitions.sh` genera
`definitions.json` desde `definitions.template.json` y variables `RABBITMQ_*` (sin contraseñas versionadas) y delega en el entrypoint oficial.

| Elemento | Valor por defecto (variable) |
|---|---|
| vhost | `collaboard` (`RABBITMQ_VHOST`) |
| exchange (direct, durable) | `notifications.events` (`RABBITMQ_EVENTS_EXCHANGE`) |
| cola principal (**quorum**, durable) | `notifications.tasks` (`RABBITMQ_TASKS_QUEUE`), binding `notification.task` |
| DLX / DLQ (quorum) | `notifications.dlx` → `notifications.tasks.dlq` (clave `notifications.failed`) |
| intentos antes de DLQ | `RABBITMQ_MAX_DELIVERIES=3` |

- **Mínimo privilegio** (verificado por `scripts/rabbit_smoke_test.py`):

  | Usuario | configure | write | read |
  |---|---|---|---|
  | `notification_api` | — | solo el exchange `notifications.events` | — |
  | `message_worker` | — | — | solo la cola `notifications.tasks` |
  | `collaboard_admin` (consola/pruebas) | todo | todo | todo |

  Ni la API ni el worker pueden declarar colas/exchanges: la topología la crea el broker al arrancar.
- **Fallos a la DLQ:** `x-delivery-limit` cuenta *reentregas*, así que `RABBITMQ_MAX_DELIVERIES` se convierte a `N-1`
  (medido: con límite 3 el broker entregaba 4 veces; con `N-1=2` entrega 3 y luego dead-letter).
- Colas **quorum** (replicadas, duraderas, con límite de entregas nativo) en lugar de clásicas con TTL.
- Datos en el volumen `rabbitmq_data`; AMQP (5672) sin publicar al host; consola solo en `127.0.0.1:15672`.

### Pendiente de Cristian
Nombres definitivos de exchange/cola/routing key y si el productor declara su propia topología. Todo es variable de entorno;
se registra en `docs/p2-pendientes-coordinacion.md`. **No se construyó ningún adaptador de eventos** (fuera de mi alcance).

## Alternativas
- *Cola clásica + TTL/reintentos manuales:* el límite de entregas y la DLQ son menos fiables.
- *Permisos amplios `.*`:* un servicio comprometido podría leer o vaciar la cola de otro.

## Consecuencias
- (+) Demostrado: publicar con confirmación, consumir con ack, rechazo → DLQ tras 3 entregas, mensajes durables tras reiniciar el broker,
  la API publica con el worker detenido y el broker caído devuelve error controlado (`scripts/rabbit_recovery.py`).
- (−) Cambiar los nombres exige recrear el volumen (las definiciones solo se cargan al crear el nodo).
- (−) La idempotencia y la garantía «al menos una vez» dependen del consumidor real (no demostrable con los stubs).
