"""Genera la grafica de la rodilla (estilo Figura 3 de Lab 6) y las tablas en Markdown y CSV."""

import csv
import json
from pathlib import Path
import statistics
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt


BASE = Path(__file__).resolve().parent
RES = BASE / "resultados"

# Referencia del Laboratorio 6 (P2 HTTP, sin TLS/S3/S4/S5) para tabla comparativa
LAB6_REF = {
    1:    (11.8,   14.3,   0.99,  5.3),
    10:   (68.9,  128.1,   9.04,  9.4),
    50:   (35.0,  135.9,  47.41, 28.1),
    100:  (83.1,  238.3,  90.78, 49.7),
    150:  (104.0, 303.5, 133.60, 76.6),
    200:  (173.5, 445.1, 167.29, 90.2),
    300:  (732.4, 988.2, 168.53, 100.3),
    500:  (1793.7, 2032.5, 170.00, 98.9),
    1000: (4339.6, 4809.5, 172.67, 98.9),
    2000: (9701.8, 12558.5, 158.28, 93.6),
}


def parse_stats(path: Path):
    by_svc = {"gateway": [], "collaboration-api": [], "board-db": []}
    if not path.exists():
        return {k: 0.0 for k in by_svc}
    with path.open(encoding="utf-8", errors="ignore") as fh:
        reader = csv.DictReader(fh)
        for row in reader:
            name = row.get("name", "")
            cpu_s = (row.get("cpu_pct") or "0").replace("%", "").strip()
            try:
                cpu = float(cpu_s)
            except ValueError:
                continue
            for svc in by_svc:
                if f"-{svc}-" in name:
                    by_svc[svc].append(cpu)
    return {k: (statistics.mean(v) if v else 0.0) for k, v in by_svc.items()}


def parse_pg(path: Path):
    tot, itx = [], []
    if not path.exists():
        return 0, 0
    with path.open(encoding="utf-8", errors="ignore") as fh:
        reader = csv.DictReader(fh)
        for row in reader:
            try:
                tot.append(int(row["total"]))
                itx.append(int(row["idle_in_tx"]))
            except (KeyError, ValueError):
                pass
    return (max(tot) if tot else 0), (max(itx) if itx else 0)


def load_rows():
    rows = []
    for jf in sorted(RES.glob("k6-*.json"), key=lambda p: int(p.stem.split("-")[1])):
        vus = int(jf.stem.split("-")[1])
        data = json.loads(jf.read_text(encoding="utf-8"))
        m = data["metrics"]
        dur = m["http_req_duration"]
        reqs = m["http_reqs"]
        failed = m["http_req_failed"]
        cpus = parse_stats(RES / f"stats-{vus}.csv")
        pg_max, pg_itx_max = parse_pg(RES / f"pg-{vus}.csv")
        err_pct = float(failed["value"]) * 100.0
        total_rps = float(reqs["rate"])
        ok_rps = total_rps * (1.0 - err_pct / 100.0)
        rows.append({
            "vus": vus,
            "reqs": int(reqs["count"]),
            "rps": ok_rps,
            "total_rps": total_rps,
            "tpm": ok_rps * 60.0,
            "avg_ms": float(dur["avg"]),
            "med_ms": float(dur.get("med", 0.0)),
            "p95_ms": float(dur["p(95)"]),
            "p99_ms": float(dur.get("p(99)", 0.0)),
            "max_ms": float(dur["max"]),
            "err_pct": err_pct,
            "cpu_collab": cpus["collaboration-api"],
            "cpu_gateway": cpus["gateway"],
            "cpu_db": cpus["board-db"],
            "pg_max": pg_max,
            "pg_itx_max": pg_itx_max,
        })
    return rows


def find_knee(rows):
    max_rps = max(r["rps"] for r in rows)
    threshold = 0.95 * max_rps
    knee = next((r for r in rows if r["rps"] >= threshold), rows[-1])
    return knee, max_rps, threshold


def plot_knee(rows, knee, max_rps, threshold):
    vus = [r["vus"] for r in rows]
    avg = [r["avg_ms"] for r in rows]
    p95 = [r["p95_ms"] for r in rows]
    rps = [r["rps"] for r in rows]
    cpu = [r["cpu_collab"] for r in rows]
    err = [r["err_pct"] for r in rows]
    fail_row = next((r for r in rows if r["err_pct"] > 0.0), None)

    plt.rcParams.update({
        "font.family": "DejaVu Sans",
        "font.size": 10,
        "axes.edgecolor": "#CCCCCC",
        "axes.linewidth": 0.8,
    })

    fig, (ax1, ax2, ax3, ax4) = plt.subplots(4, 1, figsize=(9.6, 12.2), sharex=True)
    fig.suptitle(
        "CollaBoard P3 (HTTPS + S1-S5 + Pool v2) — Curva de rendimiento, rodilla y punto de quiebre",
        fontsize=12.5, fontweight="bold", y=0.988
    )

    # Panel a: Latencia (escala log)
    ax1.plot(vus, avg, marker="o", linewidth=2, color="#1976D2", label="Promedio")
    ax1.plot(vus, p95, marker="o", linewidth=2, color="#E64A19", label="p95")
    ax1.set_xscale("log")
    ax1.set_yscale("log")
    ax1.axvline(knee["vus"], linestyle=":", color="#555555", linewidth=1.3)
    ax1.text(
        knee["vus"] * 0.90, max(p95) * 0.72, f"rodilla (CPU): {knee['vus']} VUs",
        ha="right", va="top", fontsize=9.5, fontweight="bold", color="#333333"
    )
    if fail_row:
        ax1.axvline(fail_row["vus"], linestyle="--", color="#C62828", linewidth=1.3)
        ax1.text(
            fail_row["vus"] * 0.90, max(p95) * 0.035, f"quiebre (errores): {fail_row['vus']} VUs",
            ha="right", va="top", fontsize=9.5, fontweight="bold", color="#C62828"
        )
    ax1.annotate(f"{p95[-1]:,.0f} ms", (vus[-1], p95[-1]), xytext=(6, 2), textcoords="offset points", fontsize=8.5, color="#E64A19")
    ax1.annotate(f"{avg[-1]:,.0f} ms", (vus[-1], avg[-1]), xytext=(6, -9), textcoords="offset points", fontsize=8.5, color="#1976D2")
    ax1.set_title("a) Latencia vs usuarios concurrentes", loc="left", fontsize=10.5, fontweight="bold")
    ax1.set_ylabel("Tiempo (ms, log)")
    ax1.grid(True, which="both", linestyle="-", alpha=0.22)
    ax1.legend(loc="upper left", frameon=False)

    # Panel b: Throughput
    ax2.plot(vus, rps, marker="o", linewidth=2, color="#1976D2")
    ax2.axhline(threshold, linestyle="--", color="#666666", linewidth=1.1)
    ax2.axvline(knee["vus"], linestyle=":", color="#555555", linewidth=1.3)
    if fail_row:
        ax2.axvline(fail_row["vus"], linestyle="--", color="#C62828", linewidth=1.3)
    ax2.text(vus[0] * 1.15, threshold + max_rps * 0.03, f"95 % del máximo ({threshold:.1f} req/s)", fontsize=8.5, color="#555555")
    ax2.annotate(f"{knee['rps']:.1f} req/s", (knee["vus"], knee["rps"]), xytext=(6, -14), textcoords="offset points", fontsize=8.5, fontweight="bold", color="#1976D2")
    max_row = max(rows, key=lambda r: r["rps"])
    ax2.annotate(f"máx {max_row['rps']:.1f}", (max_row["vus"], max_row["rps"]), xytext=(0, 7), textcoords="offset points", ha="center", fontsize=8.5, color="#333333")
    ax2.set_title("b) Throughput exitoso (HTTP 200)", loc="left", fontsize=10.5, fontweight="bold")
    ax2.set_ylabel("Throughput exitoso (req/s)")
    ax2.set_ylim(0, max_rps * 1.18)
    ax2.grid(True, linestyle="-", alpha=0.22)

    # Panel c: CPU collaboration-api
    ax3.plot(vus, cpu, marker="o", linewidth=2, color="#1976D2")
    ax3.axhline(100.0, linestyle="--", color="#666666", linewidth=1.1)
    ax3.axvline(knee["vus"], linestyle=":", color="#555555", linewidth=1.3)
    if fail_row:
        ax3.axvline(fail_row["vus"], linestyle="--", color="#C62828", linewidth=1.3)
    ax3.text(vus[0] * 1.15, 103.0, "límite del contenedor (1 CPU = 100 %)", fontsize=8.5, color="#555555")
    ax3.annotate(f"{knee['cpu_collab']:.1f} %", (knee["vus"], knee["cpu_collab"]), xytext=(6, -13), textcoords="offset points", fontsize=8.5, fontweight="bold", color="#1976D2")
    ax3.set_title("c) CPU del microservicio collaboration-api (media por nivel)", loc="left", fontsize=10.5, fontweight="bold")
    ax3.set_ylabel("CPU (%)")
    ax3.set_ylim(0, 114)
    ax3.grid(True, linestyle="-", alpha=0.22)

    # Panel d: Tasa de error (%)
    ax4.plot(vus, err, marker="o", linewidth=2, color="#C62828")
    ax4.fill_between(vus, err, color="#FFCDD2", alpha=0.45)
    ax4.axvline(knee["vus"], linestyle=":", color="#555555", linewidth=1.3)
    if fail_row:
        ax4.axvline(fail_row["vus"], linestyle="--", color="#C62828", linewidth=1.3)
        for r in rows:
            if r["err_pct"] > 0:
                ax4.annotate(f"{r['err_pct']:.1f} %", (r["vus"], r["err_pct"]), xytext=(0, 7), textcoords="offset points", ha="center", fontsize=8.5, fontweight="bold", color="#C62828")
    ax4.set_title("d) Tasa de error HTTP / timeouts (%)", loc="left", fontsize=10.5, fontweight="bold")
    ax4.set_ylabel("Errores (%)")
    ax4.set_xlabel("Usuarios concurrentes (VUs, escala log)")
    ax4.set_ylim(-2, max(10.0, max(err) * 1.25))
    major_ticks = [v for v in [1, 10, 50, 100, 200, 300, 500, 1000, 2000, 3000] if v in vus]
    ax4.set_xticks(major_ticks)
    ax4.set_xticklabels([str(v) for v in major_ticks])
    ax4.grid(True, linestyle="-", alpha=0.22)

    plt.tight_layout(rect=[0, 0, 1, 0.97])
    out_png = RES / "grafica-rodilla-p3.png"
    plt.savefig(out_png, dpi=200)
    plt.close(fig)
    print(f"OK: {out_png}")


def write_csv_and_md(rows, knee, max_rps, threshold):
    csv_path = RES / "resultados-curva-p3.csv"
    with csv_path.open("w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)
    print(f"OK: {csv_path}")

    # Calcular demanda de CPU media en el tramo creciente (50..rodilla)
    demands = [
        (r["cpu_collab"] / 100.0) / r["rps"] * 1000.0
        for r in rows if 50 <= r["vus"] <= knee["vus"] and r["rps"] > 0
    ]
    d_mean = statistics.mean(demands) if demands else 0.0
    ceiling_rps = (1000.0 / d_mean) if d_mean > 0 else 0.0

    lines = [
        "# Resultados completos — Curva de rendimiento y rodilla (CollaBoard P3 · `GET /api/boards`)",
        "",
        "Metodología idéntica al Laboratorio 6 (`sleep(1)`, 30 s por nivel, `timeout = 60 s`, 1 CPU en `gateway`, `collaboration-api` y `board-db`, pool `25+25` + `db.rollback()`), ejecutada sobre el stack completo **P3** (TLS 1.3 + Reverse Proxy + 8 redes segmentadas S3 + JWT corto S4 + RBAC S5).",
        "",
        "## 1. Tabla completa por nivel (P3)",
        "",
        "| VUs | Peticiones | avg (ms) | p50 (ms) | p95 (ms) | máx (ms) | error % | req/s | TPM | CPU `collab-api` | CPU `gateway` | CPU `board-db` | PG máx / `idle in tx` |",
        "|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for r in rows:
        bold = "**" if r["vus"] == knee["vus"] else ""
        lines.append(
            f"| {bold}{r['vus']}{bold} | {r['reqs']:,} | {bold}{r['avg_ms']:.1f}{bold} | {r['med_ms']:.1f} | "
            f"{bold}{r['p95_ms']:.1f}{bold} | {r['max_ms']:.1f} | {r['err_pct']:.2f} % | "
            f"{bold}{r['rps']:.2f}{bold} | {r['tpm']:,.0f} | {bold}{r['cpu_collab']:.1f} %{bold} | "
            f"{r['cpu_gateway']:.1f} % | {r['cpu_db']:.1f} % | {r['pg_max']} / {r['pg_itx_max']} |"
        )

    lines += [
        "",
        f"## 2. Identificación de la rodilla: **{knee['vus']} VUs**",
        "",
        f"- **Throughput máximo observado:** `{max_rps:.2f} req/s` (`{max_rps*60:,.0f} TPM`).",
        f"- **Umbral del 95 % del máximo (criterio Lab 6):** `{threshold:.2f} req/s`.",
        f"- **Rodilla:** primer nivel que alcanza ≥ 95 % del máximo → **`{knee['vus']} VUs`** con **`{knee['rps']:.2f} req/s`** (`{knee['tpm']:,.0f} TPM`), `avg = {knee['avg_ms']:.1f} ms`, `p95 = {knee['p95_ms']:.1f} ms` y CPU de `collaboration-api` en **`{knee['cpu_collab']:.1f} %`**.",
        f"- **Demanda de CPU por petición ($D = U / X$ en tramo 50–{knee['vus']} VUs):** **`{d_mean:.2f} ms`** → techo teórico de 1 CPU: **`{ceiling_rps:.1f} req/s`**.",
        "",
        "## 3. Comprobación con Ley de Little ($R \\approx N / X - 1\\text{ s}$ en saturación)",
        "",
        "| VUs | X medido (req/s) | R esperado ($N/X - 1\\text{ s}$) | R medido (`avg`) |",
        "|---:|---:|---:|---:|",
    ]
    for r in rows:
        if r["vus"] > knee["vus"] and r["rps"] > 0:
            r_exp = max(0.0, r["vus"] / r["rps"] - 1.0)
            lines.append(f"| {r['vus']} | {r['rps']:.2f} | {r_exp:.2f} s | {r['avg_ms']/1000.0:.2f} s |")

    lines += [
        "",
        "## 4. Comparativa directa: Laboratorio 6 (P2 HTTP) vs Prototipo 3 (HTTPS + S1–S5)",
        "",
        "| VUs | Lab 6 (P2) req/s | P3 req/s | Lab 6 (P2) p95 (ms) | P3 p95 (ms) | Lab 6 CPU `collab` | P3 CPU `collab` |",
        "|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for r in rows:
        ref = LAB6_REF.get(r["vus"])
        if ref:
            lines.append(
                f"| {r['vus']} | {ref[2]:.2f} | {r['rps']:.2f} | {ref[1]:.1f} | {r['p95_ms']:.1f} | {ref[3]:.1f} % | {r['cpu_collab']:.1f} % |"
            )

    md_path = RES / "tablas-rodilla-p3.md"
    md_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"OK: {md_path}")


def main():
    rows = load_rows()
    if not rows:
        raise SystemExit("No hay archivos k6-*.json en resultados/")
    knee, max_rps, threshold = find_knee(rows)
    plot_knee(rows, knee, max_rps, threshold)
    write_csv_and_md(rows, knee, max_rps, threshold)


if __name__ == "__main__":
    main()
