"""Pruebas de recuperación del broker (infraestructura). Subcomandos:

    publish N     publica N mensajes persistentes con confirmación (NotificationAPI)
    count         imprime los mensajes listos en la cola principal (consulta pasiva, admin)
    drain         consume y confirma todo lo pendiente (MessageWorker) e imprime cuántos
    try-publish   intenta publicar UNA vez sin reintentos; sale con 0 si el broker aceptó, 2 si no

Se ejecutan dentro de la red de Compose (ver docs/p2-despliegue.md).
"""
import json
import os
import sys
import time

import pika
from pika.exceptions import AMQPError

HOST = os.getenv("RABBITMQ_HOST", "rabbitmq")
VHOST = os.getenv("RABBITMQ_VHOST", "collaboard")
EXCHANGE = os.getenv("RABBITMQ_EVENTS_EXCHANGE", "notifications.events")
QUEUE = os.getenv("RABBITMQ_TASKS_QUEUE", "notifications.tasks")
ROUTING_KEY = os.getenv("RABBITMQ_TASKS_ROUTING_KEY", "notification.task")


def connect(user_var: str, password_var: str, attempts: int = 10):
    creds = pika.PlainCredentials(os.environ[user_var], os.environ[password_var])
    return pika.BlockingConnection(
        pika.ConnectionParameters(HOST, 5672, VHOST, creds, connection_attempts=attempts, retry_delay=2, socket_timeout=5)
    )


def publish(n: int, attempts: int = 10) -> int:
    conn = connect("RABBITMQ_NOTIFICATION_API_USER", "RABBITMQ_NOTIFICATION_API_PASSWORD", attempts)
    ch = conn.channel()
    ch.confirm_delivery()
    for i in range(n):
        ch.basic_publish(
            EXCHANGE, ROUTING_KEY, json.dumps({"recovery": i}).encode(),
            pika.BasicProperties(delivery_mode=2, content_type="application/json"), mandatory=True,
        )
    conn.close()
    return n


def count() -> int:
    conn = connect("RABBITMQ_ADMIN_USER", "RABBITMQ_ADMIN_PASSWORD")
    ch = conn.channel()
    n = ch.queue_declare(QUEUE, passive=True).method.message_count
    conn.close()
    return n


def drain() -> int:
    conn = connect("RABBITMQ_MESSAGE_WORKER_USER", "RABBITMQ_MESSAGE_WORKER_PASSWORD")
    ch = conn.channel()
    got = 0
    while True:
        method, _, _ = ch.basic_get(QUEUE, auto_ack=False)
        if not method:
            time.sleep(0.5)
            method, _, _ = ch.basic_get(QUEUE, auto_ack=False)
            if not method:
                break
        ch.basic_ack(method.delivery_tag)
        got += 1
    conn.close()
    return got


cmd = sys.argv[1] if len(sys.argv) > 1 else ""
try:
    if cmd == "publish":
        print(f"publicados={publish(int(sys.argv[2]))}")
    elif cmd == "count":
        print(f"pendientes={count()}")
    elif cmd == "drain":
        print(f"consumidos={drain()}")
    elif cmd == "try-publish":
        publish(1, attempts=1)
        print("broker aceptó el mensaje")
    else:
        sys.exit("uso: publish N | count | drain | try-publish")
except (AMQPError, OSError) as exc:
    print(f"broker no disponible: {type(exc).__name__}")
    sys.exit(2)
