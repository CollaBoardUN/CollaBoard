#!/usr/bin/env python3
import base64
import csv
import datetime
import json
import os
import re
import shlex
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

run_id = sys.argv[1]
expected = int(sys.argv[2])
started = Path(sys.argv[3])
finished = Path(sys.argv[4])

if not re.fullmatch(r"[A-Za-z0-9-]+", run_id):
    raise SystemExit("RUN_ID inválido")

folder = Path("rendimiento/notificaciones/results")
folder.mkdir(parents=True, exist_ok=True)

raw = subprocess.check_output([
    "sudo", "docker", "inspect", "--format",
    "{{json .Config.Env}}", "collaboard-rabbitmq-1"
], text=True)

env = dict(x.split("=", 1) for x in json.loads(raw) if "=" in x)

user = env["RABBITMQ_ADMIN_USER"]
password = env["RABBITMQ_ADMIN_PASSWORD"]
vhost = env.get("RABBITMQ_VHOST", "collaboard")
queue = env.get("RABBITMQ_TASKS_QUEUE", "notifications.tasks")
dlq = env.get("RABBITMQ_DLQ", "notifications.tasks.dlq")

authorization = "Basic " + base64.b64encode(
    f"{user}:{password}".encode()
).decode()

def rabbit(name):
    url = (
        "http://127.0.0.1:15672/api/queues/"
        + urllib.parse.quote(vhost, safe="")
        + "/"
        + urllib.parse.quote(name, safe="")
    )
    req = urllib.request.Request(
        url, headers={"Authorization": authorization}
    )
    with urllib.request.urlopen(req, timeout=10) as response:
        return json.load(response)

def database():
    prefix = run_id + "-%"
    sql = f"""
    SELECT
      (SELECT count(*) FROM notification_events
       WHERE event_id LIKE '{prefix}'),
      (SELECT count(*) FROM notification_outbox
       WHERE event_id LIKE '{prefix}'
         AND published_at IS NULL),
      (SELECT count(*) FROM notification_outbox
       WHERE event_id LIKE '{prefix}'
         AND published_at IS NOT NULL),
      (SELECT count(*) FROM notifications
       WHERE event_id LIKE '{prefix}'),
      (SELECT count(DISTINCT event_id) FROM notifications
       WHERE event_id LIKE '{prefix}');
    """

    cmd = (
        'psql -X -At -F "|" '
        '-U "$POSTGRES_USER" -d "$POSTGRES_DB" -c '
        + shlex.quote(sql)
    )

    raw = subprocess.check_output([
        "sudo", "docker", "exec",
        "collaboard-notification-db-1",
        "sh", "-lc", cmd
    ], text=True).strip()

    return list(map(int, raw.split("|")))

def docker_stats():
    raw = subprocess.check_output([
        "sudo", "docker", "stats", "--no-stream",
        "--format", "{{json .}}"
    ], text=True, timeout=20)

    output = []
    for line in raw.splitlines():
        item = json.loads(line)
        name = item.get("Name", "")
        if any(x in name for x in [
            "message-worker", "notification-api",
            "notification-db", "rabbitmq"
        ]):
            output.append([
                datetime.datetime.now(
                    datetime.timezone.utc
                ).isoformat(),
                name,
                item.get("CPUPerc"),
                item.get("MemUsage")
            ])
    return output

columns = [
    "timestamp_utc", "elapsed_s",
    "messages_ready", "messages_unacknowledged",
    "consumers", "dlq",
    "events_accepted", "outbox_pending",
    "outbox_published", "notifications_delivered",
    "unique_events_delivered", "backlog_end_to_end"
]

max_ready = 0
max_backlog = 0
stable = 0
last = None

with (
    (folder / f"{run_id}-cola.csv").open(
        "w", newline="", encoding="utf-8"
    ) as queue_file,
    (folder / f"{run_id}-recursos.csv").open(
        "w", newline="", encoding="utf-8"
    ) as stats_file
):
    writer = csv.writer(queue_file)
    writer.writerow(columns)

    resource_writer = csv.writer(stats_file)
    resource_writer.writerow([
        "timestamp_utc", "container", "cpu_percent", "memory"
    ])

    beginning = time.monotonic()
    sample = 0

    while time.monotonic() - beginning < int(os.getenv("MONITOR_TIMEOUT_S", "600")):
        tick = time.monotonic()

        q = rabbit(queue)
        dead = rabbit(dlq)
        accepted, pending, published, delivered, unique = database()

        ready = q.get("messages_ready") or 0
        unack = q.get("messages_unacknowledged") or 0
        dead_count = dead.get("messages") or 0
        consumers = q.get("consumers") or 0

        start_time = (
            float(started.read_text())
            if started.exists() else None
        )
        elapsed = (
            round(time.time() - start_time, 2)
            if start_time else None
        )

        now = datetime.datetime.now(
            datetime.timezone.utc
        ).isoformat()

        last = [
            now, elapsed, ready, unack, consumers,
            dead_count, accepted, pending,
            published, delivered, unique, accepted - delivered
        ]

        writer.writerow(last)
        queue_file.flush()

        max_ready = max(max_ready, ready)
        max_backlog = max(max_backlog, accepted - delivered)

        if sample % 3 == 0:
            try:
                resource_writer.writerows(docker_stats())
                stats_file.flush()
            except Exception as error:
                print("Aviso stats:", type(error).__name__)

        complete = (
            finished.exists()
            and accepted > 0
            and pending == 0
            and published == accepted
            and delivered == accepted
            and unique == accepted
            and ready == 0
            and unack == 0
            and dead_count == 0
        )

        stable = stable + 1 if complete else 0
        if stable >= 2:
            break

        sample += 1
        time.sleep(max(0, 2 - (time.monotonic() - tick)))

print("=== RESULTADO DE LA CORRIDA ===")
print("RUN_ID:", run_id)
print("Máximo mensajes pendientes:", max_ready)
print("Máximo backlog extremo a extremo:", max_backlog)
print("Última muestra:", dict(zip(columns, last)))
print("Integridad de eventos aceptados:", stable >= 2)
print("Eventos programados:", expected)
print("Eventos aceptados:", last[6] if last else "Sin datos")

if stable >= 2:
    print("Tiempo desde inicio de k6 hasta drenaje:", last[1], "s")
    print("Tasa efectiva aproximada:", round(last[6] / last[1], 2), "eventos/s")
else:
    print("No se confirmó el drenaje completo en el límite de observación.")
    sys.exit(2)
