"""Procesa resultados de k6 + docker stats de pixels-api y genera tablas y gráficas."""

import csv
import glob
import json
import os
import pathlib
import statistics
import tempfile

os.environ.setdefault("MPLCONFIGDIR", str(pathlib.Path(tempfile.gettempdir()) / "mpl_pixels"))

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt

BASE_DIR = pathlib.Path(__file__).resolve().parent
RES_DIR = BASE_DIR / "resultados"


def load_k6(path):
    data = json.loads(path.read_text(encoding="utf-8"))
    m = data.get("metrics", {})
    lat = m.get("ws_broadcast_latency_ms", m.get("http_req_duration", {}))
    msgs = m.get("ws_messages_received", m.get("http_reqs", {}))
    sent = m.get("ws_pixels_sent", {})
    errs = m.get("ws_errors", m.get("http_req_failed", {}))
    return {
        "p50": lat.get("med", 0.0),
        "p95": lat.get("p(95)", 0.0),
        "p99": lat.get("p(99)", lat.get("max", 0.0)),
        "msgs_count": msgs.get("count", 0),
        "msgs_rate": msgs.get("rate", 0.0),
        "pixels_sent": sent.get("count", 0),
        "err_rate": errs.get("value", errs.get("rate", 0.0)) * 100.0,
    }


def load_stats(path):
    if not path.exists():
        return {"gw_cpu": 0.0, "px_cpu": 0.0, "px_mem_mb": 0.0, "db_cpu": 0.0}
    gw_cpu, px_cpu, px_mem, db_cpu = [], [], [], []
    with path.open(encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        for row in reader:
            name = row.get("name", "")
            cpu_str = (row.get("cpu_pct") or "0%").replace("%", "").strip()
            mem_str = (row.get("mem_usage") or "0MiB").split("/")[0].strip()
            try:
                cpu = float(cpu_str)
            except ValueError:
                cpu = 0.0
            mem_mb = 0.0
            if mem_str.endswith("GiB"):
                mem_mb = float(mem_str[:-3]) * 1024.0
            elif mem_str.endswith("MiB"):
                mem_mb = float(mem_str[:-3])
            elif mem_str.endswith("KiB"):
                mem_mb = float(mem_str[:-3]) / 1024.0
            if "gateway" in name:
                gw_cpu.append(cpu)
            elif "pixels-api" in name:
                px_cpu.append(cpu)
                px_mem.append(mem_mb)
            elif "pixels-nosqldb" in name:
                db_cpu.append(cpu)
    return {
        "gw_cpu": statistics.median(gw_cpu) if gw_cpu else 0.0,
        "px_cpu": statistics.median(px_cpu) if px_cpu else 0.0,
        "px_mem_mb": max(px_mem) if px_mem else 0.0,
        "db_cpu": statistics.median(db_cpu) if db_cpu else 0.0,
    }


def collect_ws(prefix):
    levels = {}
    for p in sorted(RES_DIR.glob(f"{prefix}-ws-*-r*.json")):
        parts = p.stem.split("-")
        vus = int(parts[2])
        k6 = load_k6(p)
        st = load_stats(RES_DIR / f"stats-{p.stem}.csv")
        levels.setdefault(vus, []).append({**k6, **st})
    rows = []
    for vus in sorted(levels):
        runs = levels[vus]
        def med_rng(key):
            vals = sorted(r[key] for r in runs)
            return statistics.median(vals), vals[0], vals[-1]
        p50 = med_rng("p50")
        p95 = med_rng("p95")
        p99 = med_rng("p99")
        rate = med_rng("msgs_rate")
        cpu = med_rng("px_cpu")
        mem = med_rng("px_mem_mb")
        err = med_rng("err_rate")
        rows.append({
            "vus": vus, "n": len(runs),
            "p50": p50, "p95": p95, "p99": p99,
            "rate": rate, "cpu": cpu, "mem": mem, "err": err,
        })
    return rows


def plot_ws(rows_a, rows_b):
    if not rows_a and not rows_b:
        return
    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(12, 4.8), dpi=150)
    if rows_a:
        xa = [r["vus"] for r in rows_a]
        ax1.plot(xa, [r["p95"][0] for r in rows_a], "o-", color="#D32F2F", label="A · Baseline (batch=0 ms)")
        ax2.plot(xa, [r["rate"][0] for r in rows_a], "o-", color="#D32F2F", label="A · Baseline (batch=0 ms)")
    if rows_b:
        xb = [r["vus"] for r in rows_b]
        ax1.plot(xb, [r["p95"][0] for r in rows_b], "s-", color="#1976D2", label="B · Variante (batch=50 ms)")
        ax2.plot(xb, [r["rate"][0] for r in rows_b], "s-", color="#1976D2", label="B · Variante (batch=50 ms)")

    ax1.axhline(250, color="#555555", linestyle="--", linewidth=1, label="Umbral p95 (250 ms)")
    ax1.set_title("Latencia de difusión WS (p95) vs VUs")
    ax1.set_xlabel("Clientes WebSocket concurrentes (VUs)")
    ax1.set_ylabel("Latencia p95 (ms)")
    ax1.grid(True, alpha=0.3)
    ax1.legend()

    ax2.set_title("Throughput de mensajes WS vs VUs")
    ax2.set_xlabel("Clientes WebSocket concurrentes (VUs)")
    ax2.set_ylabel("Mensajes recibidos / s")
    ax2.grid(True, alpha=0.3)
    ax2.legend()

    fig.tight_layout()
    fig.savefig(RES_DIR / "grafica-ws-latencia-throughput.png")
    plt.close(fig)

    fig2, (ax3, ax4) = plt.subplots(1, 2, figsize=(12, 4.8), dpi=150)
    if rows_a:
        xa = [r["vus"] for r in rows_a]
        ax3.plot(xa, [r["cpu"][0] for r in rows_a], "o-", color="#D32F2F", label="A · Baseline (batch=0 ms)")
        ax4.plot(xa, [r["mem"][0] for r in rows_a], "o-", color="#D32F2F", label="A · Baseline (batch=0 ms)")
    if rows_b:
        xb = [r["vus"] for r in rows_b]
        ax3.plot(xb, [r["cpu"][0] for r in rows_b], "s-", color="#1976D2", label="B · Variante (batch=50 ms)")
        ax4.plot(xb, [r["mem"][0] for r in rows_b], "s-", color="#1976D2", label="B · Variante (batch=50 ms)")
    ax3.set_title("CPU de pixels-api (límite 100 % = 1 core)")
    ax3.set_xlabel("Clientes WebSocket concurrentes (VUs)")
    ax3.set_ylabel("CPU % (mediana)")
    ax3.grid(True, alpha=0.3)
    ax3.legend()

    ax4.set_title("Memoria máxima de pixels-api")
    ax4.set_xlabel("Clientes WebSocket concurrentes (VUs)")
    ax4.set_ylabel("Memoria (MiB)")
    ax4.grid(True, alpha=0.3)
    ax4.legend()

    fig2.tight_layout()
    fig2.savefig(RES_DIR / "grafica-ws-cpu-mem.png")
    plt.close(fig2)


def main():
    rows_a = collect_ws("A")
    rows_b = collect_ws("B")
    plot_ws(rows_a, rows_b)

    lines = ["# Resumen de resultados · pixels-api (Rust) + Segmentación S3\n"]
    for title, rows in [("Configuración A · Baseline (batch=0 ms)", rows_a), ("Configuración B · Variante (batch=50 ms)", rows_b)]:
        if not rows:
            continue
        lines.append(f"## {title}\n")
        lines.append("| VUs | Reps | p50 (ms) | p95 (ms) | p99 (ms) | msg/s | CPU pixels-api | Mem max (MiB) | Errores |")
        lines.append("|---:|---:|---:|---:|---:|---:|---:|---:|---:|")
        for r in rows:
            lines.append(
                f"| {r['vus']} | {r['n']} | {r['p50'][0]:.1f} | "
                f"{r['p95'][0]:.1f} ({r['p95'][1]:.1f}–{r['p95'][2]:.1f}) | "
                f"{r['p99'][0]:.1f} | {r['rate'][0]:.0f} | {r['cpu'][0]:.1f} % | "
                f"{r['mem'][0]:.1f} | {r['err'][0]:.2f} % |"
            )
        lines.append("")

    # Costo de segmentación (P2 vs P3)
    seg_p2 = [load_k6(p) for p in sorted(RES_DIR.glob("seg-p2-*.json"))]
    seg_p3 = [load_k6(p) for p in sorted(RES_DIR.glob("seg-p3-*.json"))]
    if seg_p2 or seg_p3:
        lines.append("## Costo de segmentación (`GET /api/pixels/stats` a 1500 req/s)\n")
        lines.append("| Topología | Reps | p50 (ms) | p95 (ms) | p99 (ms) | req/s | Errores |")
        lines.append("|---|---:|---:|---:|---:|---:|---:|")
        for label, runs in [("P2 · Red plana `internal`", seg_p2), ("P3 · Redes segmentadas S3", seg_p3)]:
            if not runs:
                continue
            p50 = statistics.median(r["p50"] for r in runs)
            p95 = statistics.median(r["p95"] for r in runs)
            p99 = statistics.median(r["p99"] for r in runs)
            rate = statistics.median(r["msgs_rate"] for r in runs)
            err = statistics.median(r["err_rate"] for r in runs)
            lines.append(f"| {label} | {len(runs)} | {p50:.2f} | {p95:.2f} | {p99:.2f} | {rate:.0f} | {err:.2f} % |")

        if seg_p2 and seg_p3:
            fig, (ax_lat, ax_rps) = plt.subplots(1, 2, figsize=(10.5, 4.2), dpi=150)
            labels = ["P2 (Red plana\ninternal)", "P3 (Segmentada\nedge+app+net-mongo)"]
            p50_vals = [statistics.median(r["p50"] for r in seg_p2), statistics.median(r["p50"] for r in seg_p3)]
            rps_vals = [statistics.median(r["msgs_rate"] for r in seg_p2), statistics.median(r["msgs_rate"] for r in seg_p3)]

            ax_lat.bar(labels, p50_vals, color=["#6B7280", "#E65100"], width=0.45)
            ax_lat.set_title("Costo de segmentación: latencia mediana (p50)")
            ax_lat.set_ylabel("Latencia p50 (ms)")
            ax_lat.set_ylim(0, max(p50_vals) * 1.35)
            ax_lat.grid(axis="y", alpha=0.3)
            for i, v in enumerate(p50_vals):
                ax_lat.text(i, v + 0.05, f"{v:.2f} ms", ha="center", fontweight="bold")

            ax_rps.bar(labels, rps_vals, color=["#6B7280", "#E65100"], width=0.45)
            ax_rps.set_title("Throughput servido (GET /api/pixels/stats)")
            ax_rps.set_ylabel("Peticiones / s")
            ax_rps.set_ylim(0, max(rps_vals) * 1.25)
            ax_rps.grid(axis="y", alpha=0.3)
            for i, v in enumerate(rps_vals):
                ax_rps.text(i, v + 25, f"{v:.0f} req/s", ha="center", fontweight="bold")

            fig.tight_layout()
            fig.savefig(RES_DIR / "grafica-costo-segmentacion.png")
            plt.close(fig)

    (RES_DIR / "resumen.md").write_text("\n".join(lines), encoding="utf-8")
    print("OK analizar.py -> resumen.md y gráficas generadas")


if __name__ == "__main__":
    main()

