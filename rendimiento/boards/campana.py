"""Ejecuta niveles ya seleccionados, con enfriamiento y controles entre corridas."""

import argparse
import json
import subprocess
import time
from pathlib import Path

from analizar import analyze_run


BENCH = Path(__file__).resolve().parent
RESULTS = BENCH / "resultados"
PROJECT = "collaboard-perf"


def docker(*args):
    return subprocess.check_output(["docker", *args], text=True, encoding="utf-8").strip()


def containers(project, running=False, service=None):
    args = ["ps", "-q" if running else "-aq", "--filter", f"label=com.docker.compose.project={project}"]
    if service:
        args += ["--filter", f"label=com.docker.compose.service={service}"]
    return docker(*args).splitlines()


def state(ids):
    if not ids:
        return ()
    fields = "{{.Id}}|{{.State.Status}}|{{.State.StartedAt}}|{{.RestartCount}}|{{.State.OOMKilled}}"
    return tuple(sorted(docker("inspect", "--format", fields, *ids).splitlines()))


def experimental_state():
    def persistent_ids():
        rows = docker("ps", "-a", "--filter", f"label=com.docker.compose.project={PROJECT}",
                      "--format", "{{.ID}}|{{.Names}}").splitlines()
        return [line.split("|", 1)[0] for line in rows if "k6-boards" not in line.split("|", 1)[1]]

    ids = persistent_ids()
    try:
        return state(ids)
    except subprocess.CalledProcessError:
        # Compose may recreate the experimental gateway when switching profile.
        refreshed = persistent_ids()
        if set(ids) != set(refreshed):
            return state(refreshed)
        raise


def assert_headroom(main_initial):
    if state(containers("collaboard")) != main_initial:
        raise RuntimeError("Cambió el estado del proyecto principal.")
    if any(row.endswith("|true") or "|restarting|" in row for row in experimental_state()):
        raise RuntimeError("Reinicio u OOM observado en el proyecto experimental.")
    output = docker("exec", f"{PROJECT}-board-db-1", "cat", "/proc/meminfo")
    fields = dict(line.split(":", 1) for line in output.splitlines())
    available = int(fields["MemAvailable"].split()[0])
    total = int(fields["MemTotal"].split()[0])
    if available < max(1024**2, total * 0.15):
        raise RuntimeError(f"Memoria disponible del motor insuficiente: {available // 1024} MiB.")


def stop_generator():
    owner = (BENCH / ".local" / "owner-id").read_text().strip()
    scoped = docker("ps", "-q", "--filter", f"label=edu.unal.collaboard.boards-perf={owner}",
                    "--filter", f"label=com.docker.compose.project={PROJECT}",
                    "--filter", "label=com.docker.compose.service=k6-boards").splitlines()
    if scoped:
        docker("stop", "--time", "2", *scoped)


def wait_for_recovery():
    query = ("SELECT count(*) FROM pg_stat_activity "
             "WHERE datname=current_database() AND pid<>pg_backend_pid() "
             "AND backend_type='client backend' AND state<>'idle';")
    check = 'exec psql -X -qAt -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "$1"'
    deadline = time.monotonic() + 30
    while True:
        cpu = float(docker("stats", "--no-stream", "--format", "{{.CPUPerc}}",
                           f"{PROJECT}-collaboration-api-1").rstrip("%"))
        busy = int(docker("exec", f"{PROJECT}-board-db-1", "sh", "-c", check, "boards-recovery", query))
        if cpu < 15 and busy <= 1:
            return
        if time.monotonic() >= deadline:
            raise RuntimeError(f"No regresó a reposo: CPU de Colaboración {cpu} %, conexiones ocupadas {busy}.")
        time.sleep(5)


def run_level(args, level, repetition, initial):
    if containers(PROJECT, running=True, service="k6-boards"):
        raise RuntimeError("Ya hay un generador experimental activo.")
    assert_headroom(initial)
    wait_for_recovery()
    existing = set(RESULTS.iterdir())
    command = ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(BENCH / "run.ps1"),
               "-Action", "Run", "-Experiment", args.experiment, "-Level", str(level),
               "-Variant", args.variant, "-Repetition", str(repetition), "-Phase", args.phase,
               "-MeasureSeconds", str(args.seconds)]
    if level > 400 and args.experiment == "E2":
        if not args.allow_high_load:
            raise RuntimeError("Los niveles E2 por encima de 400 requieren --allow-high-load.")
        command.append("-AllowHighLoad")
    print(f"INICIO {args.experiment}/{args.variant} nivel={level} repeticion={repetition} ventana={args.seconds}s",
          flush=True)
    with subprocess.Popen(command, cwd=BENCH.parent.parent) as process:
        while process.poll() is None:
            try:
                process.wait(timeout=12)
            except subprocess.TimeoutExpired:
                try:
                    assert_headroom(initial)
                except (RuntimeError, OSError, subprocess.CalledProcessError):
                    stop_generator()
                    process.wait(timeout=55)
                    raise
        if process.returncode:
            raise RuntimeError(f"El runner terminó con código {process.returncode}.")
    new = [path for path in set(RESULTS.iterdir()) - existing if (path / "k6.json").is_file()]
    if len(new) != 1:
        raise RuntimeError("No se identificó una única corrida nueva.")
    record, _ = analyze_run(new[0])
    keys = ("run", "valid", "invalid_reasons", "attempted", "success_tpm", "success_mean_ms",
            "success_p95_ms", "success_p99_ms", "error_pct", "other_error_pct", "http_429_pct", "timeout",
            "collaboration-api_cpu_pct_mean", "k6-boards_cpu_pct_peak", "k6-boards_memory_mib_peak",
            "pg_total_peak", "pg_idle_in_transaction_peak", "pool_timeout_count",
            "gateway_access_count", "collab_ok_correlated_count")
    print("RESULTADO " + json.dumps({key: record.get(key) for key in keys}), flush=True)
    assert_headroom(initial)
    if not record["valid"]:
        raise RuntimeError(f"Corrida inválida preservada: {record['invalid_reasons']}.")
    if record["other_error_pct"] >= args.stop_error_pct:
        raise RuntimeError(f"Umbral de parada: {args.stop_error_pct:g} % o más de fallos distintos de 429.")
    p99 = record["success_p99_ms"]
    if args.stop_p99_ms is not None and p99 is not None and p99 >= args.stop_p99_ms:
        raise RuntimeError(f"Margen hasta el timeout insuficiente: p99 alcanzó {p99:g} ms.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("experiment", choices=("E1", "E2"))
    parser.add_argument("levels", type=int, nargs="+")
    parser.add_argument("--seconds", type=int, default=90)
    parser.add_argument("--repetitions", type=int, nargs="+", default=[1])
    parser.add_argument("--phase", choices=("Sweep", "Refinement"), default="Sweep")
    parser.add_argument("--variant", choices=("Original", "Pool"), default="Original")
    parser.add_argument("--stop-error-pct", type=float, default=20)
    parser.add_argument("--stop-p99-ms", type=float)
    parser.add_argument("--allow-high-load", action="store_true")
    args = parser.parse_args()
    if not 0 < args.stop_error_pct <= 100 or (args.stop_p99_ms is not None and args.stop_p99_ms <= 0):
        parser.error("Los umbrales de parada deben ser positivos y el porcentaje debe ser como máximo 100.")
    initial = state(containers("collaboard"))
    upcoming = [(level, repetition) for index, repetition in enumerate(args.repetitions)
                for level in (args.levels if index % 2 == 0 else reversed(args.levels))]
    for index, (level, repetition) in enumerate(upcoming):
        if index:
            time.sleep(60)
        run_level(args, level, repetition, initial)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (RuntimeError, OSError, subprocess.SubprocessError) as error:
        raise SystemExit(f"PARADA: {error}")
