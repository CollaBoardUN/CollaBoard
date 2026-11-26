"""Convert per-run k6 summaries and sampled telemetry into comparable CSVs."""

import argparse
import csv
import hashlib
import json
import math
import re
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from statistics import fmean, median


OUTCOMES = (
    "success", "http_429", "http_401_403", "http_other_4xx", "http_5xx",
    "http_unexpected", "invalid_json", "timeout", "transport",
)
RESOURCE_SERVICES = ("gateway", "collaboration-api", "board-db", "k6-boards")
PG_METRICS = ("total", "active", "idle", "idle_in_transaction", "active_waiting", "max_connections")
RESOURCE_METRICS = ("cpu_pct_mean", "cpu_pct_median", "cpu_pct_peak", "memory_mib_median", "memory_mib_peak")
LATENCY_METRICS = ("mean", "max", "p50", "p95", "p99")
PROTOCOL_METRICS = ("http_10", "http_11", "http_20", "http_other", "tcp_setup", "tls_handshake")
GROUP_FIELDS = ("experiment", "unit", "revision", "engine", "compose", "docker_host",
                "k6_image", "api_rate", "burst", "connections", "warmup_s", "seconds", "variant")
COMPARISON_METRICS = ("success_tpm", "offered_tpm", "success_mean_ms", "success_p95_ms", "success_p99_ms",
                      "error_pct", "timeout", "pool_timeout_count", "pg_total_peak", "pg_idle_in_transaction_peak",
                      "collaboration-api_cpu_pct_mean", "k6-boards_cpu_pct_peak")
MEMORY_UNITS = {"B": 1, "kB": 1000, "MB": 1000**2, "GB": 1000**3, "TB": 1000**4,
                "KiB": 1024, "MiB": 1024**2, "GiB": 1024**3, "TiB": 1024**4}


def load_json(path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def window_rows(path, start, end):
    if start is None or not path.exists():
        return []
    with path.open(encoding="utf-8-sig", newline="") as source:
        return [row for row in csv.DictReader(source) if start <= int(row["timestamp_ms"]) < end]


def memory_mib(value):
    match = re.fullmatch(r"\s*([0-9.]+)\s*([a-zA-Z]+)\s*", value)
    if not match:
        raise ValueError(f"Memoria de Docker ilegible: {value!r}")
    number, unit = match.groups()
    return float(number) * MEMORY_UNITS[unit] / 1024**2


def resource_rows(run, samples):
    containers = defaultdict(list)
    for sample in samples:
        containers[sample["container"]].append(sample)
    return [
        {
            "run": run,
            "container": name,
            "service": next((service for service in RESOURCE_SERVICES if belongs_to(name, service)), ""),
            "samples": len(values),
            "cpu_pct_mean": round(fmean(float(row["cpu_pct"].rstrip("%")) for row in values), 3),
            "cpu_pct_median": round(median(float(row["cpu_pct"].rstrip("%")) for row in values), 3),
            "cpu_pct_peak": max(float(row["cpu_pct"].rstrip("%")) for row in values),
            "memory_mib_median": round(median(memory_mib(row["memory"]) for row in values), 3),
            "memory_mib_peak": round(max(memory_mib(row["memory"]) for row in values), 3),
        }
        for name, values in sorted(containers.items())
    ]


def belongs_to(container, service):
    return re.match(rf"^collaboard-perf[-_]{re.escape(service)}[-_]", container) is not None


def log_stats(path, meta, success_count):
    parsed = {}
    for service in ("gateway", "collaboration-api"):
        capture = (meta.get("log_capture") or {}).get(service) or {}
        file = path / f"{service}.csv"
        if capture.get("exit_code") == 0 and file.exists():
            with file.open(encoding="utf-8-sig", newline="") as source:
                parsed[service] = list(csv.DictReader(source))
    gateway = parsed.get("gateway")
    collaboration = parsed.get("collaboration-api")
    access = {row["request_id"] for row in gateway or [] if row["event"] == "access"}
    success_ids = {row["request_id"] for row in gateway or [] if row["event"] == "access" and row["status"] == "200"}
    canceled_ids = {row["request_id"] for row in gateway or [] if row["event"] == "access" and row["status"] == "499"}
    completed = {
        row["request_id"]: float(row["duration_ms"])
        for row in collaboration or [] if row["event"] == "request" and row["status"] == "200"
    }
    handler_ok = {
        request: duration for request, duration in completed.items() if request in success_ids
    }
    return {
        "gateway_access_count": len(access) if gateway is not None else None,
        "gateway_rate_limit_count": sum(row["event"] == "rate_limit" for row in gateway)
        if gateway is not None else None,
        "gateway_connection_limit_count": sum(row["event"] == "connection_limit" for row in gateway)
        if gateway is not None else None,
        "gateway_http_499_count": len(canceled_ids) if gateway is not None else None,
        "collab_ok_correlated_count": len(handler_ok) if collaboration is not None and gateway is not None else None,
        "collab_ok_mean_ms": fmean(handler_ok.values()) if handler_ok and len(handler_ok) == success_count else None,
        "collab_ok_after_gateway_cancel": len(canceled_ids.intersection(completed))
        if collaboration is not None and gateway is not None else None,
        "pool_timeout_count": sum(row["event"] == "queuepool_timeout" for row in collaboration)
        if collaboration is not None else None,
    }


def analyze_run(path):
    metrics = load_json(path / "k6.json")
    meta = load_json(path / "meta.json")
    experiment = metrics["experiment"]
    if experiment not in ("E1", "E2") or meta["project"] != "collaboard-perf":
        raise ValueError("Experimento o proyecto inesperado")

    seconds, attempted, start = (metrics[key] for key in ("seconds", "attempted", "window_start_ms"))
    counts = {key: metrics["outcomes"][key] for key in OUTCOMES}
    dropped = metrics["dropped"]
    interrupted = attempted - sum(counts.values())
    if seconds <= 0 or interrupted < 0 or any(count < 0 for count in (*counts.values(), dropped)):
        raise ValueError("Conteos o duración incoherentes")
    end = None if start is None else start + seconds * 1000
    resources = resource_rows(path.name, window_rows(path / "recursos.csv", start, end))
    pg = window_rows(path / "postgres.csv", start, end)
    minimum_samples = math.ceil(seconds / 5 * 0.7)

    reasons = []
    if attempted == 0 or start is None:
        reasons.append("sin_ventana_medida")
    if interrupted:
        reasons.append("iteraciones_interrumpidas")
    if dropped or metrics["warmup_dropped"]:
        reasons.append("carga_descartada_k6")
    if experiment == "E1" and abs(attempted + dropped - metrics["level"] * seconds) > 0.02 * metrics["level"] * seconds:
        reasons.append("tasa_ofrecida_incompleta")
    if experiment == "E2" and counts["http_429"]:
        reasons.append("limitador_activo_E2")
    if counts["http_401_403"] or counts["invalid_json"]:
        reasons.append("contrato_o_autenticacion")
    if meta.get("main_project_changed"):
        reasons.append("cambio_proyecto_principal")
    if len(pg) < minimum_samples:
        reasons.append("cobertura_postgres")
    for service in RESOURCE_SERVICES:
        if not any(belongs_to(row["container"], service) and row["samples"] >= minimum_samples for row in resources):
            reasons.append(f"cobertura_{service}")

    percentiles = metrics["latency_success_ms"] or {}
    rejected = metrics["latency_429_ms"] or {}
    protocol = metrics.get("protocol") or {}
    successful = counts["success"]
    if meta["action"] == "Run" and successful and percentiles.get("mean") is None:
        reasons.append("media_exitos_ausente")
    error_pct = 100 * (attempted - successful) / attempted if attempted else None
    slo = bool(
        successful and error_pct <= 1 and percentiles["p95"] <= 500 and percentiles["p99"] <= 1000
    )
    record = {
        "run": path.name, "action": meta["action"], "experiment": experiment, "level": metrics["level"],
        "variant": meta.get("variant", "Original"),
        "unit": "req/s" if experiment == "E1" else "VU", "repetition": meta["repetition"],
        "phase": meta.get("phase", "Pilot" if meta["action"] == "Pilot" else "Sweep"),
        "run_started_at_utc": meta.get("run_started_at_utc"),
        "window_start_ms": start,
        "window_start_utc": datetime.fromtimestamp(start / 1000, timezone.utc).isoformat() if start else None,
        "window_end_ms": end,
        "revision": meta["revision"], "engine": meta["engine"], "compose": meta["compose"],
        "docker_host": meta["docker_host"], "k6_image": meta["k6_image"],
        "api_rate": meta["api_rate"], "burst": meta["burst"], "connections": meta["connections"],
        "warmup_s": metrics["warmup"], "seconds": seconds,
        "attempted": attempted, "dropped": dropped, "warmup_dropped": metrics["warmup_dropped"],
        "interrupted": interrupted, **counts,
        "offered_tpm": round(attempted * 60 / seconds, 3),
        "success_tpm": round(successful * 60 / seconds, 3),
        "success_req_s": round(successful / seconds, 6),
        "error_pct": None if error_pct is None else round(error_pct, 4),
        "http_429_pct": round(100 * counts["http_429"] / attempted, 4) if attempted else None,
        "other_error_pct": round(100 * (attempted - successful - counts["http_429"]) / attempted, 4)
        if attempted else None,
        **{f"{key}_pct": round(100 * counts[key] / attempted, 4) if attempted else None
           for key in OUTCOMES if key not in ("success", "http_429")},
        **{f"success_{key}_ms": percentiles.get(key) for key in LATENCY_METRICS},
        **{f"http_429_{key}_ms": rejected.get(key) for key in LATENCY_METRICS},
        **{f"protocol_{key}": protocol.get(key) for key in (*PROTOCOL_METRICS, "reuse_enabled")},
        **log_stats(path, meta, successful),
        "log_capture_incomplete": bool(meta.get("log_capture_failed") or any(
            entry.get("exit_code") != 0 for entry in (meta.get("log_capture") or {}).values()
        )),
        "pg_samples": len(pg), "slo_met": slo, "valid": not reasons, "invalid_reasons": "|".join(reasons),
    }
    profile = [record[key] for key in GROUP_FIELDS if key != "variant"] + [meta.get(key) for key in (
        "bench_code_sha256", "resource_limits", "k6_image_id", "ca_sha256", "physical_host",
        "gateway_directives", "cgroup_version",
    )]
    images = meta.get("images") or []
    profile += [[image for image in images if not image.startswith("/collaboard-perf-collaboration-api-")]]
    record["comparison"] = hashlib.sha256(json.dumps(profile, sort_keys=True).encode()).hexdigest()[:12]
    full_profile = [*profile, record["variant"], images]
    record["cohort"] = hashlib.sha256(json.dumps(full_profile, sort_keys=True).encode()).hexdigest()[:12]
    for service in RESOURCE_SERVICES:
        matches = [row for row in resources if row["service"] == service]
        for key in RESOURCE_METRICS:
            record[f"{service}_{key}"] = matches[0][key] if len(matches) == 1 else None
    for key in PG_METRICS:
        values = [int(row[key]) for row in pg]
        record[f"pg_{key}_median"] = median(values) if values else None
        record[f"pg_{key}_peak"] = max(values) if values else None
    return record, resources


def level_rows(records):
    groups = defaultdict(list)
    keys = ("cohort", "comparison", "level", *GROUP_FIELDS)
    for row in records:
        if row["action"] == "Run":
            groups[tuple(row[key] for key in keys)].append(row)
    for group, rows in sorted(groups.items()):
        valid = [row for row in rows if row["valid"]]
        ids = {row["repetition"] for row in valid}
        distinct = len(ids) == len(valid)
        combined = dict(zip(keys, group))
        combined.update(valid_runs=len(valid), total_runs=len(rows), distinct_repetitions=len(ids),
                        phases=",".join(sorted({row["phase"] for row in valid})),
                        comparable=distinct and len(ids) >= 3,
                        all_valid_runs_meet_slo=bool(valid) and all(row["slo_met"] for row in valid))
        metrics = dict.fromkeys((
            *COMPARISON_METRICS, "success_req_s", "http_429_pct", "other_error_pct", "timeout_pct",
            "pg_active_peak", "pg_idle_peak", "pg_active_waiting_peak",
            "gateway_rate_limit_count", "gateway_connection_limit_count", "gateway_http_499_count",
            *(f"{kind}_{stat}_ms" for kind in ("success", "http_429") for stat in LATENCY_METRICS),
            *(f"{service}_{metric}" for service in RESOURCE_SERVICES for metric in RESOURCE_METRICS),
        ))
        for key in metrics:
            values = [row[key] for row in valid if row[key] is not None]
            combined[f"{key}_median"] = median(values) if values else None
            combined[f"{key}_min"] = min(values) if values else None
            combined[f"{key}_max"] = max(values) if values else None
        yield combined


def comparison_rows(levels):
    groups = defaultdict(list)
    for row in levels:
        if row["experiment"] == "E2" and row["valid_runs"]:
            groups[row["comparison"], row["level"]].append(row)
    for (profile, level), rows in sorted(groups.items()):
        if len(rows) != 2 or {row["variant"] for row in rows} != {"Original", "Pool"}:
            continue
        result = {"comparison": profile, "level": level, "seconds": rows[0]["seconds"]}
        for row in rows:
            label = row["variant"].lower()
            result[f"{label}_cohort"] = row["cohort"]
            result[f"{label}_repetitions"] = row["valid_runs"]
            for metric in COMPARISON_METRICS:
                for stat in ("median", "min", "max"):
                    result[f"{label}_{metric}_{stat}"] = row[f"{metric}_{stat}"]
        yield result


def consistency_rows(records):
    for row in records:
        if row["experiment"] != "E2" or row["action"] != "Run" or not row["valid"]:
            continue
        n, latency, x = row["level"], row["success_mean_ms"], row["success_req_s"]
        # The success cohort represents the whole closed loop only with zero errors.
        comparable = row["success"] == row["attempted"] and bool(latency) and x > 0
        expected = n * 1000 / latency if comparable else None
        cpu = row["collaboration-api_cpu_pct_mean"]
        demand_ms = 10 * cpu / x if comparable and cpu is not None else None
        handler = row["collab_ok_mean_ms"]
        yield {
            "run": row["run"], "cohort": row["cohort"], "level": n, "repetition": row["repetition"],
            "applicable": comparable, "success_mean_ms": latency, "measured_req_s": x,
            "measured_tpm": row["success_tpm"], "little_expected_req_s": expected,
            "little_expected_tpm": expected * 60 if comparable else None,
            "little_difference_pct": 100 * (x - expected) / expected if comparable else None,
            "little_expected_ms": n * 1000 / x if comparable else None,
            "observed_concurrency_e2e": x * latency / 1000 if comparable else None,
            "observed_concurrency_collab": x * handler / 1000 if comparable and handler is not None else None,
            "collaboration_cpu_pct_mean": cpu, "cpu_demand_ms": demand_ms,
            "estimated_cpu_ceiling_tpm": 60000 / demand_ms if demand_ms else None,
        }


def write_csv(path, rows, fields=()):
    with path.open("w", encoding="utf-8", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=list(rows[0]) if rows else fields)
        writer.writeheader()
        writer.writerows(rows)


def write_pool_tables(results, records, levels):
    fields = (
        "run", "cohort", "phase", "level", "repetition", "seconds", "valid", "invalid_reasons", "slo_met",
        "attempted", "success", "offered_tpm", "success_tpm",
        *(f"success_{stat}_ms" for stat in LATENCY_METRICS),
        "error_pct", "timeout_pct", "timeout", "http_401_403", "http_429", "http_5xx", "dropped",
        "collaboration-api_cpu_pct_mean", "collaboration-api_memory_mib_peak", "gateway_cpu_pct_mean",
        "board-db_cpu_pct_mean", "k6-boards_cpu_pct_peak", "k6-boards_memory_mib_peak",
        "pg_total_peak", "pg_active_peak", "pg_idle_peak", "pg_idle_in_transaction_peak", "pool_timeout_count",
    )
    runs = [{key: row[key] for key in fields} for row in records if row["variant"] == "Pool"]
    write_csv(results / "tabla-variante-corridas.csv", runs, fields)

    measurements = (
        "offered_tpm", "success_tpm", "success_mean_ms", "success_p50_ms", "success_p95_ms", "success_p99_ms",
        "error_pct", "timeout_pct", "collaboration-api_cpu_pct_mean", "collaboration-api_memory_mib_peak",
        "pg_total_peak", "pg_idle_in_transaction_peak",
    )
    fields = (
        "cohort", "level", "seconds", "valid_runs", "total_runs", "comparable", "all_valid_runs_meet_slo",
        *(f"{metric}_{stat}" for metric in measurements for stat in ("median", "min", "max")),
    )
    summary = [{key: row[key] for key in fields} for row in levels if row["variant"] == "Pool"]
    write_csv(results / "tabla-variante-niveles.csv", summary, fields)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("results", type=Path, help="Directorio que contiene una subcarpeta por corrida")
    parser.add_argument("--no-plots", action="store_true", help="Escribe solo los CSV")
    parser.add_argument("--cohort", help="Selecciona un perfil comparable para las figuras")
    parser.add_argument("--partial", action="store_true",
                        help="Con --cohort, grafica E2 de 90 s con réplicas incompletas y muestra n por nivel")
    parser.add_argument("--refinement", type=int, nargs=2, metavar=("MIN", "MAX"))
    parser.add_argument("--latency-range", type=int, nargs=2, metavar=("MIN", "MAX"),
                        help="Grafica el cumplimiento del objetivo de latencia en estos niveles comparables")
    parser.add_argument("--knee", type=int, nargs=2, metavar=("MIN", "MAX"),
                        help="Anota un intervalo confirmado externamente")
    parser.add_argument("--optimum", type=int, help="Anota un nivel confirmado externamente")
    parser.add_argument("--limit", type=int, help="Anota un nivel confirmado externamente")
    parser.add_argument("--pg-run", action="append", default=[], help="Corrida para la figura de PostgreSQL")
    args = parser.parse_args()
    if not args.results.is_dir():
        parser.error("El directorio de resultados no existe.")
    if args.partial and (not args.cohort or args.no_plots or any(
        point is not None for point in (args.knee, args.optimum, args.limit)
    )):
        parser.error("--partial requiere --cohort y figuras sin anotaciones de puntos confirmados.")

    records, resources, issues = [], [], []
    for path in sorted(item for item in args.results.iterdir() if item.is_dir() and item.name != "figuras"):
        try:
            record, resource = analyze_run(path)
        except (OSError, ValueError, KeyError, TypeError) as error:
            issues.append({"run": path.name, "kind": "incomplete", "error": str(error)})
            continue
        if not record["valid"]:
            issues.append({"run": path.name, "kind": "invalid", "error": record["invalid_reasons"]})
        if record["log_capture_incomplete"]:
            issues.append({"run": path.name, "kind": "log_capture", "error": "captura_incompleta"})
        records.append(record)
        resources.extend(resource)

    records.sort(key=lambda row: (row["window_start_ms"] or 0, row["run"]))
    for order, record in enumerate(records, 1):
        record["observed_order"] = order
    levels = list(level_rows(records))
    write_pool_tables(args.results, records, levels)
    write_csv(args.results / "corridas.csv", records, ("run",))
    write_csv(args.results / "niveles.csv", levels, ("experiment", "level"))
    write_csv(args.results / "recursos_resumen.csv", resources, ("run", "container"))
    write_csv(args.results / "incidencias.csv", issues, ("run", "kind", "error"))
    write_csv(args.results / "comprobaciones.csv", list(consistency_rows(records)), ("run", "level"))
    matched = list(comparison_rows(levels))
    write_csv(args.results / "comparacion-variante.csv", matched, ("comparison", "level", "seconds"))
    if not args.no_plots:
        try:
            from graficas import generate

            generate(args, levels, records, window_rows, matched)
        except ImportError as error:
            parser.error(f"{error}. Instale matplotlib o use --no-plots.")
        except ValueError as error:
            parser.error(str(error))
    print(f"Corridas analizadas: {len(records)}. Incidencias: {len(issues)}.")
    return 0 if records and not any(row["kind"] == "incomplete" for row in issues) else 1


if __name__ == "__main__":
    raise SystemExit(main())
