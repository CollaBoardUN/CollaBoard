"""Smoke test de RabbitMQ: publica con los permisos de NotificationAPI y consume
con los del MessageWorker, y comprueba el mínimo privilegio y la DLQ.

Es SOLO infraestructura: no usa el formato real de los eventos de Cristian.

Uso (dentro de la red de Compose, sin instalar nada en el host):
    docker compose --profile tools run --rm rabbit-smoke
Variables: RABBITMQ_HOST, RABBITMQ_PORT y las mismas RABBITMQ_* de .env.
"""
import json
import os
import sys
import time
import uuid

import pika
from pika.exceptions import AMQPError, ChannelClosedByBroker, ProbableAccessDeniedError, ProbableAuthenticationError

HOST = os.getenv("RABBITMQ_HOST", "rabbitmq")
PORT = int(os.getenv("RABBITMQ_PORT", "5672"))
VHOST = os.getenv("RABBITMQ_VHOST", "collaboard")
EXCHANGE = os.getenv("RABBITMQ_EVENTS_EXCHANGE", "notifications.events")
QUEUE = os.getenv("RABBITMQ_TASKS_QUEUE", "notifications.tasks")
ROUTING_KEY = os.getenv("RABBITMQ_TASKS_ROUTING_KEY", "notification.task")
DLQ = os.getenv("RABBITMQ_DLQ", "notifications.tasks.dlq")
MAX_DELIVERIES = int(os.getenv("RABBITMQ_MAX_DELIVERIES", "3"))

API = (os.environ["RABBITMQ_NOTIFICATION_API_USER"], os.environ["RABBITMQ_NOTIFICATION_API_PASSWORD"])
WORKER = (os.environ["RABBITMQ_MESSAGE_WORKER_USER"], os.environ["RABBITMQ_MESSAGE_WORKER_PASSWORD"])

failures = 0


def report(ok: bool, name: str, extra: str = "") -> None:
    global failures
    if not ok:
        failures += 1
    print(f"{'OK  ' if ok else 'FAIL'} {name}{' — ' + extra if extra else ''}", flush=True)


def connect(creds):
    params = pika.ConnectionParameters(
        HOST, PORT, VHOST, pika.PlainCredentials(*creds), heartbeat=30, connection_attempts=10, retry_delay=2
    )
    return pika.BlockingConnection(params)


def publish(body: dict, message_id: str) -> bool:
    """Publica persistente y con confirmación (publisher confirms) como el productor real."""
    conn = connect(API)
    try:
        ch = conn.channel()
        ch.confirm_delivery()
        ch.basic_publish(
            EXCHANGE,
            ROUTING_KEY,
            json.dumps(body).encode(),
            pika.BasicProperties(delivery_mode=2, content_type="application/json", message_id=message_id),
            mandatory=True,
        )
        return True
    except AMQPError as exc:
        print("publicación rechazada:", repr(exc))
        return False
    finally:
        if conn.is_open:
            conn.close()


def get_one(queue: str, creds, ack=True, wait=10.0):
    conn = connect(creds)
    try:
        ch = conn.channel()
        deadline = time.time() + wait
        while time.time() < deadline:
            method, props, body = ch.basic_get(queue, auto_ack=False)
            if method:
                if ack:
                    ch.basic_ack(method.delivery_tag)
                return method, props, body
            time.sleep(0.3)
        return None, None, None
    finally:
        if conn.is_open:
            conn.close()


def expect_denied(name: str, fn) -> None:
    try:
        fn()
        report(False, name, "se permitió, esperaba acceso denegado")
    except (ChannelClosedByBroker, ProbableAccessDeniedError, ProbableAuthenticationError) as exc:
        report(True, name, "denegado: " + str(exc).split("'")[-2][:60] if "'" in str(exc) else "denegado")
    except AMQPError as exc:
        report(True, name, f"denegado ({type(exc).__name__})")


# 1) Publicar -> consumir -> ack
marker = str(uuid.uuid4())
report(publish({"smoke": marker}, marker), "NotificationAPI publica con confirmación")
method, props, body = get_one(QUEUE, WORKER)
report(
    method is not None and json.loads(body).get("smoke") == marker and props.delivery_mode == 2,
    "MessageWorker consume y confirma (mensaje persistente)",
)

# 2) Mínimo privilegio
def api_cannot_read():
    conn = connect(API)
    try:
        conn.channel().basic_get(QUEUE)
    finally:
        if conn.is_open:
            conn.close()


def worker_cannot_publish():
    conn = connect(WORKER)
    try:
        ch = conn.channel()
        ch.confirm_delivery()
        ch.basic_publish(EXCHANGE, ROUTING_KEY, b"{}", mandatory=True)
    finally:
        if conn.is_open:
            conn.close()


def api_cannot_declare():
    conn = connect(API)
    try:
        conn.channel().queue_declare("cola-no-permitida", durable=True)
    finally:
        if conn.is_open:
            conn.close()


expect_denied("NotificationAPI NO puede leer la cola", api_cannot_read)
expect_denied("MessageWorker NO puede publicar en el exchange", worker_cannot_publish)
expect_denied("NotificationAPI NO puede declarar colas nuevas", api_cannot_declare)

# 3) Mensaje venenoso: tras MAX_DELIVERIES entregas sin ack termina en la DLQ
poison = str(uuid.uuid4())
publish({"smoke": poison, "invalid": True}, poison)
deliveries = 0
for _ in range(MAX_DELIVERIES + 2):
    conn = connect(WORKER)
    try:
        ch = conn.channel()
        deadline = time.time() + 6
        got = None
        while time.time() < deadline and not got:
            method, props, body = ch.basic_get(QUEUE, auto_ack=False)
            if method and json.loads(body).get("smoke") == poison:
                got = method
            elif method:
                ch.basic_ack(method.delivery_tag)
            else:
                time.sleep(0.3)
        if not got:
            break
        deliveries += 1
        ch.basic_nack(got.delivery_tag, requeue=True)
    finally:
        if conn.is_open:
            conn.close()
report(deliveries == MAX_DELIVERIES, f"mensaje rechazado se entrega {MAX_DELIVERIES} veces", f"entregas={deliveries}")

# La DLQ solo la lee el administrador; el worker no tiene permiso: comprobar con el admin
admin = (os.environ["RABBITMQ_ADMIN_USER"], os.environ["RABBITMQ_ADMIN_PASSWORD"])
method, props, body = get_one(DLQ, admin, wait=10)
report(method is not None and json.loads(body).get("smoke") == poison, "tras el límite el mensaje llega a la DLQ")

print("\nTodas las comprobaciones pasaron." if failures == 0 else f"\n{failures} comprobación(es) fallaron.")
sys.exit(0 if failures == 0 else 1)
