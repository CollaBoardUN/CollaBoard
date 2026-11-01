#!/bin/sh
# Genera /etc/rabbitmq/definitions.json desde la plantilla y las variables de
# entorno, y delega en el entrypoint oficial. Así no se versionan contraseñas.
set -eu

require() {
  eval "value=\${$1:-}"
  if [ -z "$value" ]; then
    echo "rabbitmq: falta la variable $1" >&2
    exit 1
  fi
}

# Escapa los caracteres especiales del reemplazo de sed. Evitar comillas y
# barras invertidas en las contraseñas (se insertan dentro de JSON).
esc() { printf '%s' "$1" | sed -e 's/[\/&|]/\\&/g'; }

for v in RABBITMQ_ADMIN_USER RABBITMQ_ADMIN_PASSWORD \
         RABBITMQ_NOTIFICATION_API_USER RABBITMQ_NOTIFICATION_API_PASSWORD \
         RABBITMQ_MESSAGE_WORKER_USER RABBITMQ_MESSAGE_WORKER_PASSWORD; do
  require "$v"
done

VHOST="${RABBITMQ_VHOST:-collaboard}"
EXCHANGE="${RABBITMQ_EVENTS_EXCHANGE:-notifications.events}"
QUEUE="${RABBITMQ_TASKS_QUEUE:-notifications.tasks}"
ROUTING_KEY="${RABBITMQ_TASKS_ROUTING_KEY:-notification.task}"
DLX="${RABBITMQ_DLX:-notifications.dlx}"
DLQ="${RABBITMQ_DLQ:-notifications.tasks.dlq}"
DLQ_ROUTING_KEY="${RABBITMQ_DLQ_ROUTING_KEY:-notifications.failed}"
MAX_DELIVERIES="${RABBITMQ_MAX_DELIVERIES:-3}"
# x-delivery-limit cuenta REENTREGAS: con límite N el mensaje se entrega N+1 veces.
# RABBITMQ_MAX_DELIVERIES son los intentos totales (3 = una entrega + 2 reentregas).
case "$MAX_DELIVERIES" in ''|*[!0-9]*|0) echo "rabbitmq: RABBITMQ_MAX_DELIVERIES debe ser un entero >= 1" >&2; exit 1 ;; esac
DELIVERY_LIMIT=$((MAX_DELIVERIES - 1))

# Los nombres se usan como expresión regular en permisos: el punto es literal en la práctica.
sed \
  -e "s|__ADMIN_USER__|$(esc "$RABBITMQ_ADMIN_USER")|g" \
  -e "s|__ADMIN_PASSWORD__|$(esc "$RABBITMQ_ADMIN_PASSWORD")|g" \
  -e "s|__NOTIFICATION_API_USER__|$(esc "$RABBITMQ_NOTIFICATION_API_USER")|g" \
  -e "s|__NOTIFICATION_API_PASSWORD__|$(esc "$RABBITMQ_NOTIFICATION_API_PASSWORD")|g" \
  -e "s|__MESSAGE_WORKER_USER__|$(esc "$RABBITMQ_MESSAGE_WORKER_USER")|g" \
  -e "s|__MESSAGE_WORKER_PASSWORD__|$(esc "$RABBITMQ_MESSAGE_WORKER_PASSWORD")|g" \
  -e "s|__VHOST__|$(esc "$VHOST")|g" \
  -e "s|__EXCHANGE__|$(esc "$EXCHANGE")|g" \
  -e "s|__QUEUE__|$(esc "$QUEUE")|g" \
  -e "s|__ROUTING_KEY__|$(esc "$ROUTING_KEY")|g" \
  -e "s|__DLX__|$(esc "$DLX")|g" \
  -e "s|__DLQ__|$(esc "$DLQ")|g" \
  -e "s|__DLQ_ROUTING_KEY__|$(esc "$DLQ_ROUTING_KEY")|g" \
  -e "s|__DELIVERY_LIMIT__|$DELIVERY_LIMIT|g" \
  /etc/rabbitmq/definitions.template.json > /etc/rabbitmq/definitions.json
chmod 644 /etc/rabbitmq/definitions.json

exec docker-entrypoint.sh "$@"
