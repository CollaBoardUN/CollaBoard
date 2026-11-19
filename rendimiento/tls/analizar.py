"""Resume la prueba "costo de TLS": tablas (mediana y rango de las repeticiones) y gráficas.

    python rendimiento/tls/analizar.py [rendimiento/tls/resultados]

Lee index-*.csv, los resúmenes de k6 (*.json) y stats-*.csv (docker stats) que deja run.sh.
Escribe resumen.csv, resumen.md y las gráficas PNG en la misma carpeta. Requiere matplotlib.
"""

import csv
import json
import pathlib
import statistics
import sys

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt

OUT = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else pathlib.Path(__file__).parent / "resultados")
CONFIGS = {
    "A-reuse": ("A · HTTP keep-alive (P2)", "#6B7280", "o"),
    "A-new": ("A′ · HTTP conexión nueva (P2)", "#9CA3AF", "s"),
    "C-reuse": ("C · HTTPS keep-alive, HTTP/1.1", "#1F5FD6", "o"),
    "B-new": ("B · HTTPS conexión nueva (handshake completo)", "#DC2626", "s"),
    "D-h2": ("D · HTTPS keep-alive, HTTP/2", "#059669", "^"),
}
MARGIN_S = 5  # se descartan los primeros/últimos segundos de cada nivel al promediar CPU


def cpu_series():
    """{contenedor_corto: [(epoch, cpu%)]} con todos los stats-*.csv."""
    series = {}
    for path in OUT.glob("stats-*.csv"):
        with path.open(encoding="utf-8") as f:
            for row in csv.DictReader(f):
                name = row["container"]
                short = "k6" if name.startswith("k6-") else name.split("-", 1)[1].rsplit("-", 1)[0]
                try:
                    series.setdefault(short, []).append((int(row["epoch"]), float(row["cpu_pct"].rstrip("%"))))
                except ValueError:
                    continue
    return series


def mean_cpu(series, name, start, end):
    values = [c for t, c in series.get(name, []) if start + MARGIN_S <= t <= end - MARGIN_S]
    return statistics.fmean(values) if values else float("nan")


def runs():
    for path in sorted(OUT.glob("index-*.csv")):
        with path.open(encoding="utf-8") as f:
            yield from csv.DictReader(f)


def main():
    series = cpu_series()
    groups = {}
    for run in runs():
        summary = OUT / run["file"]
        if not summary.exists():
            continue
        m = json.loads(summary.read_text(encoding="utf-8"))["metrics"]
        d = m["http_req_duration"]
        start, end = int(run["start"]), int(run["end"])
        rps = m["http_reqs"]["rate"]
        gw = mean_cpu(series, "gateway", start, end)
        groups.setdefault((run["config"], run["endpoint"], int(run["level"])), []).append(
            {
                "p50": d["med"],
                "p95": d["p(95)"],
                "p99": d["p(99)"],
                "rps": rps,
                "err": m["http_req_failed"]["value"] * 100,
                "tls": m["http_req_tls_handshaking"]["avg"],
                "conn": m["http_req_connecting"]["avg"],
                "gw_cpu": gw,
                "gw_us_req": gw / 100 / rps * 1e6 if rps else float("nan"),
                "web_cpu": mean_cpu(series, "web-ssr", start, end),
                "k6_cpu": mean_cpu(series, "k6", start, end),
            }
        )

    keys = ["p50", "p95", "p99", "rps", "err", "tls", "conn", "gw_cpu", "gw_us_req", "web_cpu", "k6_cpu"]
    rows = []
    for (config, endpoint, level), reps in sorted(
        groups.items(), key=lambda kv: (kv[0][1], list(CONFIGS).index(kv[0][0]), kv[0][2])
    ):
        row = {"config": config, "endpoint": endpoint, "level": level, "reps": len(reps)}
        for k in keys:
            vals = [r[k] for r in reps]
            row[k] = statistics.median(vals)
            row[k + "_min"], row[k + "_max"] = min(vals), max(vals)
        rows.append(row)

    with (OUT / "resumen.csv").open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0]))
        w.writeheader()
        w.writerows(rows)

    def rng(r, k, fmt):
        return fmt.format(r[k]) + (f" ({fmt.format(r[k + '_min'])}–{fmt.format(r[k + '_max'])})" if r["reps"] > 1 else "")

    lines = []
    for endpoint, unit in (("healthz", "req/s ofrecidas"), ("dashboard", "VUs")):
        lines += [
            f"### {endpoint}",
            "",
            f"| Configuración | {unit} | rep. | p50 (ms) | p95 (ms) | p99 (ms) | req/s | errores % | handshake TLS (ms) | CPU gateway % | CPU gateway µs/req | CPU web-ssr % |",
            "|---|---|---|---|---|---|---|---|---|---|---|---|",
        ]
        for r in (r for r in rows if r["endpoint"] == endpoint):
            lines.append(
                f"| {CONFIGS[r['config']][0]} | {r['level']} | {r['reps']} | {rng(r, 'p50', '{:.2f}')} | {rng(r, 'p95', '{:.2f}')} | "
                f"{rng(r, 'p99', '{:.2f}')} | {rng(r, 'rps', '{:.1f}')} | {r['err']:.2f} | {r['tls']:.3f} | "
                f"{rng(r, 'gw_cpu', '{:.1f}')} | {r['gw_us_req']:.0f} | {r['web_cpu']:.1f} |"
            )
        lines.append("")
    (OUT / "resumen.md").write_text("\n".join(lines), encoding="utf-8")

    plt.rcParams.update({"font.size": 9, "axes.spines.top": False, "axes.spines.right": False})
    for endpoint, xlabel, panels in (
        (
            "healthz",
            "Llegadas por segundo (tasa fija)",
            (("p95", "Latencia p95 (ms)"), ("gw_cpu", "CPU del gateway (% de 1 núcleo)")),
        ),
        ("dashboard", "Usuarios virtuales (bucle cerrado)", (("p95", "Latencia p95 (ms)"), ("rps", "Throughput (req/s)"))),
    ):
        fig, axes = plt.subplots(1, 2, figsize=(10, 3.6))
        for ax, (key, ylabel) in zip(axes, panels):
            for config, (label, color, marker) in CONFIGS.items():
                pts = sorted(
                    (r["level"], r[key], r[key + "_min"], r[key + "_max"])
                    for r in rows
                    if r["endpoint"] == endpoint and r["config"] == config
                )
                if not pts:
                    continue
                x, y, lo, hi = zip(*pts)
                ax.errorbar(
                    x,
                    y,
                    yerr=[[a - b for a, b in zip(y, lo)], [b - a for a, b in zip(y, hi)]],
                    label=label,
                    color=color,
                    marker=marker,
                    capsize=3,
                    linewidth=1.6,
                )
            ax.set_xlabel(xlabel)
            ax.grid(alpha=0.3)
            if endpoint == "healthz" and key == "p95":
                # De 0,6 ms a 120 ms: en escala lineal las configuraciones baratas se aplastan.
                ax.set_yscale("log")
                ylabel += " · escala log"
            else:
                ax.set_ylim(bottom=0)
            ax.set_ylabel(ylabel)
        axes[0].legend(fontsize=7, frameon=False)
        fig.suptitle(
            f"Costo de TLS · GET {'/healthz (solo gateway)' if endpoint == 'healthz' else '/ (dashboard SSR)'}", fontsize=10
        )
        fig.tight_layout()
        fig.savefig(OUT / f"grafica-{endpoint}.png", dpi=160)
        plt.close(fig)
    print(f"resumen.csv, resumen.md y gráficas en {OUT}")


if __name__ == "__main__":
    main()
