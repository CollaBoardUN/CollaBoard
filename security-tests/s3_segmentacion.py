"""Escenario S3 · Network Segmentation: verifica aislamiento por zonas y cero egreso.

    python security-tests/s3_segmentacion.py
    python security-tests/s3_segmentacion.py --evidence docs/p3/evidencia/S3/despues
    python security-tests/s3_segmentacion.py --evidence docs/p3/evidencia/S3/antes   # contra P2

Solo usa la biblioteca estándar de Python y Docker (`nicolaka/netshoot` inyectado
en el namespace de red de cada contenedor origen con `--network container:<id>`).

Comprueba, contra P2 (antes) y P3 (después):

  1. Conectividad permitida (100 % debe responder TCP): cada servicio alcanza
     únicamente sus destinos autorizados (APIs permitidas y su propio almacén/broker).
  2. Bloqueo de movimiento lateral hacia almacenes/broker ajenos (100 % debe fallar):
     ninguna API ni el gateway/SSR alcanza bases de datos o colas de otro dominio.
  3. Aislamiento de `message-worker` respecto a la zona `app` (100 % debe fallar):
     no alcanza gateway, SSR ni ninguna API HTTP.
  4. Cero salida a Internet (100 % debe fallar) desde los contenedores de las zonas
     internas (`app` y `net-*`).
  5. Inspección de redes Docker (`internal: true` en `app` y `net-*`, `edge` única
     red con salida al host).

Imprime OK/FAIL por comprobación y termina con código 1 si alguna falla.
--evidence DIR guarda s3-resumen.json, s3-matriz.md, s3-redes.json y s3-salida.txt.
"""

import argparse
import json
import os
import pathlib
import subprocess
import sys

FAILS = []
OUTPUT_LINES = []

PROBE_IMAGE = "nicolaka/netshoot"

# Todos los endpoints TCP internos evaluados
TARGETS = [
    ("gateway", 80),
    ("gateway", 8081),
    ("web-ssr", 3000),
    ("auth-api", 8001),
    ("collaboration-api", 8000),
    ("pizarra-api", 8000),
    ("chat-api", 8090),
    ("pixels-api", 8000),
    ("notification-api", 8080),
    ("user-db", 5432),
    ("board-db", 5432),
    ("canvas-db", 5432),
    ("notification-db", 5432),
    ("pixels-nosqldb", 27017),
    ("rabbitmq", 5672),
]

DATA_AND_BROKER = {
    ("user-db", 5432),
    ("board-db", 5432),
    ("canvas-db", 5432),
    ("notification-db", 5432),
    ("pixels-nosqldb", 27017),
    ("rabbitmq", 5672),
}

APP_SERVICES = {
    ("gateway", 80),
    ("gateway", 8081),
    ("web-ssr", 3000),
    ("auth-api", 8001),
    ("collaboration-api", 8000),
    ("pizarra-api", 8000),
    ("chat-api", 8090),
    ("pixels-api", 8000),
    ("notification-api", 8080),
}

# Matriz oficial (REPARTO_P3.md, sección S3.C.1)
ALLOWED_MATRIX = {
    "gateway": {
        ("web-ssr", 3000),
        ("auth-api", 8001),
        ("collaboration-api", 8000),
        ("pizarra-api", 8000),
        ("chat-api", 8090),
        ("pixels-api", 8000),
        ("notification-api", 8080),
    },
    "web-ssr": {
        ("gateway", 8081),
    },
    "auth-api": {
        ("user-db", 5432),
    },
    "collaboration-api": {
        ("board-db", 5432),
        ("notification-api", 8080),
        ("pizarra-api", 8000),
    },
    "pizarra-api": {
        ("canvas-db", 5432),
        ("collaboration-api", 8000),
    },
    "chat-api": {
        ("pixels-nosqldb", 27017),
        ("collaboration-api", 8000),
        ("notification-api", 8080),
    },
    "pixels-api": {
        ("pixels-nosqldb", 27017),
    },
    "notification-api": {
        ("notification-db", 5432),
        ("rabbitmq", 5672),
    },
    "message-worker": {
        ("notification-db", 5432),
        ("rabbitmq", 5672),
    },
}

# Contenedores internos cuyo egreso a Internet (1.1.1.1:443) debe estar bloqueado
INTERNAL_ONLY_ORIGINS = [
    "web-ssr",
    "auth-api",
    "collaboration-api",
    "pizarra-api",
    "chat-api",
    "pixels-api",
    "notification-api",
    "message-worker",
    "user-db",
    "board-db",
    "canvas-db",
    "notification-db",
    "pixels-nosqldb",
    "rabbitmq",
]

# Topología de redes esperada en P3
EXPECTED_NETWORKS_P3 = {
    "edge": {"internal": False, "members": {"gateway", "pixels-ui"}},
    "app": {
        "internal": True,
        "members": {
            "gateway",
            "web-ssr",
            "auth-api",
            "collaboration-api",
            "pizarra-api",
            "chat-api",
            "pixels-api",
            "notification-api",
        },
    },
    "net-user": {"internal": True, "members": {"auth-api", "user-db"}},
    "net-board": {"internal": True, "members": {"collaboration-api", "board-db"}},
    "net-canvas": {"internal": True, "members": {"pizarra-api", "canvas-db"}},
    "net-notif": {"internal": True, "members": {"notification-api", "message-worker", "notification-db"}},
    "net-mongo": {"internal": True, "members": {"chat-api", "pixels-api", "pixels-nosqldb"}},
    "net-mq": {"internal": True, "members": {"notification-api", "message-worker", "rabbitmq"}},
}


def log(line):
    OUTPUT_LINES.append(line)
    print(line, flush=True)


def report(ok, name, detail=""):
    if not ok:
        FAILS.append(name)
    log(f"{'OK  ' if ok else 'FAIL'} {name}{' — ' + detail if detail else ''}")


def run_cmd(cmd, timeout=60):
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, check=False)


def discover_services(project_filter=None):
    """Devuelve {service_name: container_name} de los contenedores en ejecución."""
    cmd = [
        "docker",
        "ps",
        "--filter",
        "status=running",
        "--format",
        "{{.Names}}\t{{.Label \"com.docker.compose.service\"}}\t{{.Label \"com.docker.compose.project\"}}",
    ]
    res = run_cmd(cmd, timeout=15)
    services = {}
    detected_project = project_filter
    for line in res.stdout.splitlines():
        parts = line.split("\t")
        if len(parts) < 3 or not parts[1]:
            continue
        cname, svc, proj = parts[0].strip(), parts[1].strip(), parts[2].strip()
        if detected_project is None:
            detected_project = proj
        if proj == detected_project:
            services[svc] = cname
    return services, detected_project


def ensure_probe_image():
    check = run_cmd(["docker", "image", "inspect", PROBE_IMAGE], timeout=10)
    if check.returncode == 0:
        return True
    log(f"Descargando imagen sonda {PROBE_IMAGE}...")
    pull = run_cmd(["docker", "pull", PROBE_IMAGE], timeout=180)
    return pull.returncode == 0


def probe_from_container(container_name, targets_to_probe, check_egress=True):
    """Ejecuta un solo contenedor sonda en el namespace de red del origen para probar TCP."""
    checks_sh = []
    for host, port in targets_to_probe:
        checks_sh.append(
            f'if nc -z -w 2 "{host}" {port} >/dev/null 2>&1; then echo "OPEN {host}:{port}"; '
            f'else echo "CLOSED {host}:{port}"; fi'
        )
    if check_egress:
        checks_sh.append(
            'if nc -z -w 2 1.1.1.1 443 >/dev/null 2>&1; then echo "EGRESS OPEN"; '
            'else echo "EGRESS CLOSED"; fi'
        )
    script = "; ".join(checks_sh)
    cmd = [
        "docker",
        "run",
        "--rm",
        "--network",
        f"container:{container_name}",
        PROBE_IMAGE,
        "sh",
        "-c",
        script,
    ]
    res = run_cmd(cmd, timeout=90)
    results = {}
    egress_open = None
    for line in res.stdout.splitlines():
        line = line.strip()
        if line.startswith("OPEN "):
            results[line[5:]] = True
        elif line.startswith("CLOSED "):
            results[line[7:]] = False
        elif line == "EGRESS OPEN":
            egress_open = True
        elif line == "EGRESS CLOSED":
            egress_open = False
    return results, egress_open, res.stderr.strip()


def inspect_networks(project_name):
    res = run_cmd(["docker", "network", "ls", "--format", "{{.Name}}"], timeout=15)
    nets = [n.strip() for n in res.stdout.splitlines() if n.strip().startswith(f"{project_name}_")]
    if not nets:
        return {}
    insp = run_cmd(["docker", "network", "inspect", *nets], timeout=15)
    if insp.returncode != 0:
        return {}
    raw = json.loads(insp.stdout)
    summary = {}
    for net in raw:
        short_name = net["Name"].removeprefix(f"{project_name}_")
        containers = {
            c.get("Name", cid)
            for cid, c in (net.get("Containers") or {}).items()
        }
        summary[short_name] = {
            "full_name": net["Name"],
            "driver": net.get("Driver"),
            "internal": bool(net.get("Internal", False)),
            "containers": sorted(containers),
        }
    return summary


def build_markdown_matrix(matrix_records, origins, targets):
    cols = [f"{h}:{p}" for h, p in targets]
    lines = [
        "| Origen | " + " | ".join(cols) + " | Internet (1.1.1.1:443) |",
        "|---|" + "|".join([":---:"] * len(cols)) + "|:---:|",
    ]
    for orig in origins:
        row_cells = []
        for h, p in targets:
            key = f"{h}:{p}"
            rec = matrix_records.get(orig, {}).get("targets", {}).get(key)
            if rec is None:
                row_cells.append("—")
            elif rec["expected"] == "ALLOW":
                row_cells.append("OK (ALLOW)" if rec["open"] else "FAIL (DROP)")
            elif rec["expected"] == "DENY":
                row_cells.append("OK (DENY)" if not rec["open"] else "FAIL (EXPUESTO)")
            else:
                row_cells.append("OPEN (app)" if rec["open"] else "CLOSED")
        eg = matrix_records.get(orig, {}).get("egress_open")
        eg_cell = "—" if eg is None else ("FAIL (SALIDA)" if eg else "OK (BLOQUEADO)")
        lines.append(f"| `{orig}` | " + " | ".join(row_cells) + f" | {eg_cell} |")
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description="Verifica segmentación de redes S3.")
    parser.add_argument("--project", default=None, help="Nombre del proyecto Docker Compose")
    parser.add_argument("--evidence", default=None, help="Directorio donde guardar evidencia JSON/MD/TXT")
    args = parser.parse_args()

    services, project = discover_services(args.project)
    if not services:
        report(False, "contenedores del stack en ejecución", "no se encontraron contenedores Compose activos")
        return 1

    log(f"S3 · Network Segmentation (proyecto Compose: {project}, {len(services)} contenedores)\n")

    if not ensure_probe_image():
        report(False, f"imagen sonda {PROBE_IMAGE} disponible")
        return 1

    # 1. Probar matriz TCP desde cada contenedor origen de aplicación
    origins = [
        "gateway",
        "web-ssr",
        "auth-api",
        "collaboration-api",
        "pizarra-api",
        "chat-api",
        "pixels-api",
        "notification-api",
        "message-worker",
    ]

    matrix_records = {}
    allowed_ok = 0
    allowed_total = 0
    denied_data_blocked = 0
    denied_data_total = 0
    denied_worker_app_blocked = 0
    denied_worker_app_total = 0
    egress_blocked = 0
    egress_total = 0

    for orig in origins:
        cname = services.get(orig)
        if not cname:
            report(False, f"origen {orig} en ejecución", "contenedor no encontrado")
            continue

        allowed_set = ALLOWED_MATRIX.get(orig, set())
        targets_to_test = [
            (h, p)
            for h, p in TARGETS
            if h != orig and (
                (h, p) in allowed_set
                or (h, p) in DATA_AND_BROKER
                or (
                    orig == "message-worker"
                    and (h, p) in APP_SERVICES
                    and h != "notification-api"
                )
            )
        ]

        results, egress_open, stderr = probe_from_container(
            cname, targets_to_test, check_egress=(orig in INTERNAL_ONLY_ORIGINS)
        )
        if not results and stderr:
            report(False, f"sonda de red en {orig}", stderr)
            continue

        orig_targets = {}
        orig_allowed_fails = []
        orig_denied_leaks = []

        for h, p in targets_to_test:
            key = f"{h}:{p}"
            is_open = results.get(key, False)
            if (h, p) in allowed_set:
                expected = "ALLOW"
                allowed_total += 1
                if is_open:
                    allowed_ok += 1
                else:
                    orig_allowed_fails.append(key)
            elif (h, p) in DATA_AND_BROKER or (
                orig == "message-worker" and (h, p) in APP_SERVICES and h != "notification-api"
            ):
                expected = "DENY"
                if (h, p) in DATA_AND_BROKER:
                    denied_data_total += 1
                    if not is_open:
                        denied_data_blocked += 1
                    else:
                        orig_denied_leaks.append(key)
                else:
                    denied_worker_app_total += 1
                    if not is_open:
                        denied_worker_app_blocked += 1
                    else:
                        orig_denied_leaks.append(key)
            else:
                expected = "INFO"

            orig_targets[key] = {"open": is_open, "expected": expected}

        report(
            not orig_allowed_fails,
            f"{orig}: pares permitidos alcanzan su destino",
            f"OK ({len(allowed_set)}/{len(allowed_set)})"
            if not orig_allowed_fails
            else f"fallaron: {', '.join(orig_allowed_fails)}",
        )
        report(
            not orig_denied_leaks,
            f"{orig}: movimiento lateral prohibido bloqueado",
            "0 fugas"
            if not orig_denied_leaks
            else f"CONECTA a destinos prohibidos: {', '.join(orig_denied_leaks)}",
        )

        if orig in INTERNAL_ONLY_ORIGINS:
            egress_total += 1
            if egress_open is False:
                egress_blocked += 1
            report(
                egress_open is False,
                f"{orig}: sin salida a Internet (1.1.1.1:443)",
                "bloqueado" if egress_open is False else "EXPUESTO (sale a Internet)",
            )

        matrix_records[orig] = {"targets": orig_targets, "egress_open": egress_open}

    # 2. Verificar egreso a Internet en contenedores de datos y broker
    for db_orig in ("user-db", "board-db", "canvas-db", "notification-db", "pixels-nosqldb", "rabbitmq"):
        cname = services.get(db_orig)
        if not cname:
            continue
        _, egress_open, _ = probe_from_container(cname, [], check_egress=True)
        egress_total += 1
        if egress_open is False:
            egress_blocked += 1
        report(
            egress_open is False,
            f"{db_orig}: zona de datos sin salida a Internet",
            "bloqueado" if egress_open is False else "EXPUESTO (sale a Internet)",
        )
        matrix_records[db_orig] = {"targets": {}, "egress_open": egress_open}

    # 3. Verificar topología de redes Docker (internal: true y membresía exacta)
    nets = inspect_networks(project)
    for net_name, spec in EXPECTED_NETWORKS_P3.items():
        info = nets.get(net_name)
        if not info:
            report(False, f"red Docker '{net_name}' existe", "no encontrada")
            continue
        expected_containers = {services[s] for s in spec["members"] if s in services}
        actual_containers = set(info["containers"])
        # Permitir contenedores sonda efímeros si alguno quedara, filtrando solo miembros del stack
        stack_cnames = set(services.values())
        actual_stack_members = actual_containers & stack_cnames
        members_ok = actual_stack_members == expected_containers
        internal_ok = info["internal"] == spec["internal"]
        detail = (
            f"internal={info['internal']}, miembros={len(actual_stack_members)}"
            if (members_ok and internal_ok)
            else f"internal={info['internal']} (esp. {spec['internal']}), "
                 f"faltan={sorted(expected_containers - actual_stack_members)}, "
                 f"sobran={sorted(actual_stack_members - expected_containers)}"
        )
        report(members_ok and internal_ok, f"topología red '{net_name}'", detail)

    # Tabla compacta esperado vs observado en consola (requisito S3.C.4)
    log("\nMatriz Esperado vs Observado (destinos de datos/broker + egreso):")
    db_Targets = [("user-db", 5432), ("board-db", 5432), ("canvas-db", 5432), ("notification-db", 5432), ("pixels-nosqldb", 27017), ("rabbitmq", 5672)]
    hdr = f"{'Origen':<18} | " + " | ".join(f"{h.split('-')[0]:<10}" for h, _ in db_Targets) + " | Internet"
    log(hdr)
    log("-" * len(hdr))
    for orig in origins:
        cells = []
        tmap = matrix_records.get(orig, {}).get("targets", {})
        for h, p in db_Targets:
            rec = tmap.get(f"{h}:{p}")
            if not rec:
                cells.append(f"{'--':<10}")
            else:
                exp = "ALLOW" if rec["expected"] == "ALLOW" else "DENY"
                obs = "OPEN" if rec["open"] else "DROP"
                cells.append(f"{exp}/{obs:<4}")
        eg = matrix_records.get(orig, {}).get("egress_open")
        eg_str = "N/A (edge)" if eg is None else ("DENY/OPEN!" if eg else "DENY/DROP")
        log(f"{orig:<18} | " + " | ".join(cells) + f" | {eg_str}")

    # Resumen cuantitativo
    log("")
    log(
        f"Resumen S3 — Permitidos: {allowed_ok}/{allowed_total} | "
        f"Bloqueados datos/broker: {denied_data_blocked}/{denied_data_total} | "
        f"Bloqueados worker->app: {denied_worker_app_blocked}/{denied_worker_app_total} | "
        f"Sin egreso a Internet: {egress_blocked}/{egress_total}"
    )

    if args.evidence:
        ev_dir = pathlib.Path(args.evidence)
        ev_dir.mkdir(parents=True, exist_ok=True)
        summary = {
            "project": project,
            "allowed": {"ok": allowed_ok, "total": allowed_total},
            "denied_data": {"blocked": denied_data_blocked, "total": denied_data_total},
            "denied_worker_app": {"blocked": denied_worker_app_blocked, "total": denied_worker_app_total},
            "egress": {"blocked": egress_blocked, "total": egress_total},
            "networks": nets,
            "matrix": matrix_records,
            "fallos": FAILS,
        }
        (ev_dir / "s3-resumen.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
        (ev_dir / "s3-redes.json").write_text(json.dumps(nets, ensure_ascii=False, indent=2), encoding="utf-8")
        (ev_dir / "s3-matriz.md").write_text(
            build_markdown_matrix(matrix_records, origins, TARGETS), encoding="utf-8"
        )
        (ev_dir / "s3-salida.txt").write_text("\n".join(OUTPUT_LINES) + "\n", encoding="utf-8")
        log(f"\nEvidencia guardada en {ev_dir}")

    log(f"\n{'Todas las comprobaciones OK' if not FAILS else f'{len(FAILS)} comprobaciones fallaron'}")
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(main())

