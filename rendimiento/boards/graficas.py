"""Figuras de CollaBoard con escalas, unidades y rangos del protocolo P3."""

import re
from collections import defaultdict

import matplotlib

matplotlib.use("Agg")
from matplotlib import pyplot as plt
from matplotlib.ticker import MaxNLocator, NullFormatter


BLUE, ORANGE, GREEN, GRAY, PURPLE = "#2872c7", "#e76a36", "#1f9c79", "#646973", "#8158a3"
SHADE = "#f8dccb"


def panel(axis, title, ylabel):
    axis.set_title(title, loc="left", fontweight="bold", fontsize=10)
    axis.set(ylabel=ylabel, facecolor="#fafafa")
    axis.spines[["top", "right"]].set_visible(False)
    axis.grid(True, color="#e3e5e8", linewidth=0.65)
    axis.set_axisbelow(True)


def series(axis, rows, metric, label, color, *, log=False, right=False):
    suffix = f"{metric}_median"
    selected = [row for row in rows if row.get(suffix) is not None and (not log or row[suffix] > 0)]
    if not selected:
        return
    center = [row[suffix] for row in selected]
    error_low = [value - row[f"{metric}_min"] if not log or row[f"{metric}_min"] > 0 else 0
                 for row, value in zip(selected, center)]
    error_high = [row[f"{metric}_max"] - value for row, value in zip(selected, center)]
    ranges = (error_low, error_high) if any(error_low) or any(error_high) else None
    axis.errorbar([row["level"] for row in selected], center, yerr=ranges,
                  label=label, color=color, fmt="o-", markersize=4, linewidth=1.55, capsize=2.5)
    if right:
        axis.yaxis.label.set_color(color)
        axis.tick_params(axis="y", colors=color)


def legend(axis, *, frameon=False, **options):
    if axis.get_legend_handles_labels()[0]:
        axis.legend(frameon=frameon, fontsize=8, **options)


def save(fig, base, caption):
    # La numeración la asigna el informe; la figura conserva solo la descripción.
    caption = re.sub(r"^Figura \d+\.\s*", "", caption)
    fig.text(0.5, 0.016, caption, ha="center", style="italic", fontsize=8, color=GRAY)
    fig.tight_layout(rect=(0, 0.048, 1, 1))
    fig.savefig(base.with_suffix(".png"), dpi=200, facecolor="white")
    fig.savefig(base.with_suffix(".svg"), facecolor="white")
    plt.close(fig)


def deployment_figure(folder):
    fig, axis = plt.subplots(figsize=(8.2, 3.1))
    axis.set(xlim=(-0.65, 7.85), ylim=(-1.1, 1.6))
    axis.set_title("Vista de despliegue de la prueba de listados", loc="left", fontweight="bold", fontsize=10)
    axis.axis("off")
    axis.axhspan(-0.92, 1.28, color="#f6f7f8")
    axis.text(-0.43, 1.07, "Proyecto Docker collaboard-perf", fontsize=9, fontweight="bold")

    for x, label in ((0.25, "k6-boards"), (2.45, "gateway"), (4.78, "collaboration-api"),
                     (7.0, "board-db")):
        axis.text(x, 0.26, label, ha="center", va="center", color=BLUE,
                  bbox={"boxstyle": "round,pad=0.48", "fc": "white", "ec": BLUE})
    for left, right, network, protocol in ((0.86, 1.96, "edge", "HTTPS"),
                                           (2.91, 3.91, "app", "HTTP"),
                                           (5.65, 6.50, "net-board", "PostgreSQL")):
        axis.annotate("", (right, 0.26), (left, 0.26), arrowprops={"arrowstyle": "->", "color": BLUE})
        axis.text((left + right) / 2, 0.48, network, ha="center", color=GRAY, fontsize=8)
        axis.text((left + right) / 2, 0.02, protocol, ha="center", color=GRAY, fontsize=8)
    axis.text(2.45, -0.54, "auth-api · emisión de JWT (preparación)", va="center", ha="center", color=GRAY,
              bbox={"boxstyle": "round,pad=0.4", "fc": "#eceef0", "ec": "#bdc2c9"})
    axis.annotate("", (2.45, -0.33), (2.45, 0.05),
                  arrowprops={"arrowstyle": "->", "color": GRAY, "linestyle": ":"})
    axis.text(5.88, -0.53, "Otros servicios P3 desplegados\nfuera de la ruta medida", color=GRAY,
              ha="center", va="center", fontsize=8)
    save(fig, folder / "figura-1-despliegue", "Figura 1. Recorrido medido de GET /api/boards y acceso auxiliar de autenticación.")


def figure_e1(rows, folder):
    fig, (throughput, errors) = plt.subplots(2, 1, sharex=True, figsize=(8.2, 5.2))
    rates = [row["level"] for row in rows]
    limit = int(rows[0]["api_rate"].split("r/")[0])
    panel(throughput, "a) Throughput por IP", "TPM")
    series(throughput, rows, "offered_tpm", "Ofrecidas", GRAY)
    series(throughput, rows, "success_tpm", "Exitosas", BLUE)
    throughput.axhline(limit * 60, color=GRAY, linestyle=":", label=f"{limit} req/s por IP")
    legend(throughput)
    panel(errors, "b) Rechazos del gateway", "429 (%)")
    series(errors, rows, "http_429_pct", "429 observados", ORANGE)
    guide = sorted(set([*rates, *([limit] if rates[0] <= limit <= rates[-1] else [])]))
    errors.plot(guide, [100 * max(0, 1 - limit / rate) for rate in guide], color=GRAY, linestyle=":",
                label="Referencia sostenida, sin ráfaga")
    errors.set(xlabel="Tasa ofrecida (req/s)", xticks=rates, ylim=(-3, 103))
    legend(errors)
    save(fig, folder / "figura-2-e1", "Figura 2. E1 por IP. Mediana y rango de corridas válidas.")


def annotate_e2(axis, annotations, *, labels=False):
    knee, optimum, limit = annotations
    if knee:
        axis.axvspan(*knee, color=SHADE, alpha=0.8, label="Intervalo de rodilla" if labels else None)
    for point, label in ((optimum, "Óptimo operativo"), (limit, "Límite práctico")):
        if point is not None:
            axis.axvline(point, color=GRAY, linestyle=":", linewidth=1,
                         label=label if labels else None)


def tick_vus(axis, rows, partial):
    labels = [f"{row['level']}\n{row['valid_runs']}" if partial else str(row["level"]) for row in rows]
    axis.set_xticks([row["level"] for row in rows], labels)
    if partial:
        axis.set_xlabel("Usuarios concurrentes (VUs) · segunda fila: réplicas válidas")


def axis_vus(axis, rows, partial=False):
    axis.set(xscale="log", xlabel="Usuarios concurrentes (VUs)")
    stride = max(1, (len(rows) + 11) // 12)
    tick_rows = rows[::stride]
    if (len(rows) - 1) % stride:
        tick_rows.append(rows[-1])
    tick_vus(axis, tick_rows, partial)
    axis.xaxis.set_minor_formatter(NullFormatter())


def figure_e2(rows, folder, annotations, exploratory=False, partial=False):
    variant = "pool ajustado" if rows[0]["variant"] == "Pool" else "original"
    if partial:
        variant += " · 90 s, serie parcial"
    fig, (latency, throughput, cpu) = plt.subplots(3, 1, sharex=True, figsize=(8.2, 7.0))
    panel(latency, "a) Latencia de listados exitosos", "Latencia (ms)")
    latency.set_yscale("log")
    for stat, color in (("p50", BLUE), ("p95", ORANGE), ("p99", GREEN)):
        series(latency, rows, f"success_{stat}_ms", stat, color, log=True)
    for threshold in (500, 1000):
        latency.axhline(threshold, linestyle=":", color=GRAY, linewidth=0.9, label=f"{threshold} ms")
    panel(throughput, "b) Throughput", "TPM")
    if any(row["offered_tpm_median"] != row["success_tpm_median"] for row in rows):
        series(throughput, rows, "offered_tpm", "TPM ofrecidas", GRAY)
    series(throughput, rows, "success_tpm", "TPM exitosas", BLUE)
    peak = max(rows, key=lambda row: row["success_tpm_median"])
    maximum = peak["success_tpm_median"]
    if len(rows) >= 2 and maximum > 0:
        if not partial:
            throughput.axhline(maximum * 0.95, linestyle=":", color=GRAY, label="95 % del máximo observado")
        throughput.annotate(f"{maximum:,.0f} TPM".replace(",", " "), (peak["level"], peak["success_tpm_max"]),
                            xytext=(0, 9), textcoords="offset points", ha="center", fontsize=8, color=BLUE)
        throughput.margins(y=0.2)
    for row in rows:
        if row["error_pct_median"] >= 20:
            throughput.annotate(f"{row['error_pct_median']:.1f} % fallos", (row["level"], row["success_tpm_median"]),
                                xytext=(-5, 9), textcoords="offset points", ha="right", fontsize=8, color=ORANGE)
    panel(cpu, "c) Utilización media por corrida y componente", "CPU (%)")
    for service, color in (("collaboration-api", ORANGE), ("gateway", BLUE), ("board-db", GREEN),
                           ("k6-boards", PURPLE)):
        series(cpu, rows, f"{service}_cpu_pct_mean", service, color)
    cpu.axhline(100, linestyle=":", color=GRAY, label="Cuota de 1 CPU")
    for axis in (latency, throughput, cpu):
        annotate_e2(axis, annotations, labels=axis is throughput)
        legend(axis, ncol=2, frameon=axis is throughput, facecolor="white", edgecolor="none", framealpha=1)
    axis_vus(cpu, rows, partial)
    caption = f"E2 {variant}, exploratorio. Puntos observados en ventanas breves." if exploratory else (
        f"Figura 3. E2 {variant}. Mediana y rango de corridas válidas."
    )
    save(fig, folder / "figura-3-e2", caption)

    fig, ram = plt.subplots(figsize=(8.2, 3.4))
    panel(ram, "Memoria por componente", "RAM (MiB)")
    for service, color in (("collaboration-api", ORANGE), ("gateway", BLUE), ("board-db", GREEN),
                           ("k6-boards", PURPLE)):
        series(ram, rows, f"{service}_memory_mib_median", service, color)
    annotate_e2(ram, annotations)
    axis_vus(ram, rows, partial)
    legend(ram, ncol=2)
    save(fig, folder / "e2-ram", f"Memoria de contenedores en E2 {variant}. " + (
        "Puntos exploratorios." if exploratory else "Mediana y rango de corridas válidas."
    ))

    fig, errors = plt.subplots(figsize=(8.2, 3.4))
    panel(errors, "Fallos y timeouts observados", "Intentos (%)")
    if all(row["error_pct_max"] == 0 for row in rows):
        series(errors, rows, "error_pct", "Fallos totales y timeouts: 0 %", ORANGE)
    else:
        series(errors, rows, "error_pct", "Fallos totales", ORANGE)
        series(errors, rows, "timeout_pct", "Timeouts de cliente", PURPLE)
    errors.axhline(1, color=GRAY, linestyle=":", linewidth=1, label="SLO de fallos: 1 %")
    errors.set_ylim(bottom=-0.05)
    annotate_e2(errors, annotations)
    axis_vus(errors, rows, partial)
    legend(errors, ncol=2)
    save(fig, folder / "e2-errores", f"E2 {variant}. Porcentajes observados durante la medición.")

    fig, connections = plt.subplots(figsize=(8.2, 3.4))
    panel(connections, "Picos por estado de PostgreSQL", "Conexiones")
    for state, label, color in (("total", "Totales", GRAY), ("active", "Activas", BLUE),
                                ("idle", "Inactivas", GREEN), ("idle_in_transaction", "Inactivas en transacción", ORANGE)):
        series(connections, rows, f"pg_{state}_peak", label, color)
    connections.yaxis.set_major_locator(MaxNLocator(integer=True))
    annotate_e2(connections, annotations)
    axis_vus(connections, rows, partial)
    legend(connections, ncol=2)
    save(fig, folder / "e2-postgres-niveles",
         f"E2 {variant}. El pico de cada estado puede ocurrir en una muestra distinta.")


def figure_refinement(rows, folder, knee, partial=False):
    fig, tpm = plt.subplots(figsize=(8.2, 3.7))
    latency = tpm.twinx()
    panel(tpm, "Ampliación de los niveles refinados", "TPM exitosas")
    latency.set_ylabel("p95 (ms)")
    latency.spines["top"].set_visible(False)
    series(tpm, rows, "success_tpm", "TPM exitosas", BLUE)
    series(latency, rows, "success_p95_ms", "p95", ORANGE, right=True)
    if knee:
        annotate_e2(tpm, (knee, None, None), labels=True)
    tpm.set(xlabel="Usuarios concurrentes (VUs)")
    tick_vus(tpm, rows, partial)
    legend(tpm, loc="upper left")
    legend(latency, loc="upper center")
    caption = "Figura 4. Detalle del intervalo observado. Mediana y rango."
    if partial:
        caption += " Serie parcial de 90 s."
    save(fig, folder / "figura-4-refinamiento", caption)


def figure_latency_range(rows, folder, partial=False):
    fig, axis = plt.subplots(figsize=(8.2, 3.7))
    panel(axis, "Cruce del objetivo de latencia", "Latencia (ms)")
    series(axis, rows, "success_p95_ms", "p95", ORANGE)
    series(axis, rows, "success_p99_ms", "p99", GREEN)
    axis.axhline(500, color=ORANGE, linewidth=1, linestyle=":", label="Objetivo p95: 500 ms")
    axis.axhline(1000, color=GREEN, linewidth=1, linestyle=":", label="Objetivo p99: 1 000 ms")
    axis.set(xlabel="Usuarios concurrentes (VUs)")
    tick_vus(axis, rows, partial)
    legend(axis, ncol=2)
    caption = "E2. Mediana y rango de corridas válidas por nivel."
    if partial:
        caption += " Serie parcial de 90 s."
    save(fig, folder / "e2-umbral-latencia", caption)


def figure_postgres(runs, results, folder, window_rows, pilot=False):
    fig, axes = plt.subplots(len(runs), 1, figsize=(8.2, 3.1 * len(runs)), sharey=True, squeeze=False)
    ymax = 1
    for axis, run in zip(axes[:, 0], runs):
        start, end = run["window_start_ms"], run["window_end_ms"]
        rows = window_rows(results / run["run"] / "postgres.csv", start, end)
        if not rows:
            plt.close(fig)
            raise ValueError(f"Sin muestras PostgreSQL en {run['run']}.")
        elapsed = [(int(row["timestamp_ms"]) - start) / 1000 for row in rows]
        original = run["variant"] == "Original"
        variant = "original" if original else "pool ajustado"
        unit = "VUs" if run["unit"] == "VU" and run["level"] > 1 else run["unit"]
        panel(axis, f"{run['run']} · {run['level']} {unit} · {variant}", "Conexiones")
        for metric, label, color in (("total", "Totales", GRAY), ("active", "Activas", BLUE),
                                     ("idle", "Inactivas", GREEN), ("idle_in_transaction", "Inactivas en transacción", ORANGE),
                                     ("active_waiting", "Activas en espera", PURPLE)):
            axis.step(elapsed, [int(row[metric]) for row in rows], where="post", color=color,
                      marker="o", markersize=3.5, label=label)
        if original:
            axis.axhline(15, color=GRAY, linestyle=":", label="Referencia del pool 5 + 10")
            retained = [int(row["idle_in_transaction"]) >= 15 and int(row["active"]) == 0 for row in rows]
            for index, (first, second) in enumerate(zip(retained, retained[1:])):
                if first and second:
                    axis.axvspan(elapsed[index], elapsed[index + 1], color=SHADE, alpha=0.65)
        axis.set(xlim=(0, (end - start) / 1000), xlabel="Segundos desde el inicio de la medición")
        ymax = max(ymax, 15 if original else 1, max(int(row["total"]) for row in rows))
        axis.yaxis.set_major_locator(MaxNLocator(integer=True))
        legend(axis, ncol=3, loc="upper right")
    axes[0, 0].set_ylim(bottom=-0.4, top=1.38 * ymax)
    filename = "piloto-postgres" if pilot else "figura-5-postgres"
    caption = "Piloto de integración. Estados de PostgreSQL." if pilot else "Figura 5. Estados de PostgreSQL en las corridas seleccionadas."
    save(fig, folder / filename, caption)


def figure_comparison(rows, folder):
    panels = (
        ("success_tpm", "a) Throughput exitoso", "TPM"),
        ("success_p95_ms", "b) p95 de los éxitos", "ms"),
        ("error_pct", "c) Fallos de cliente", "% de intentos"),
        ("collaboration-api_cpu_pct_mean", "d) CPU de Colaboración", "% de un núcleo"),
        ("pg_idle_in_transaction_peak", "e) Pico idle in transaction", "Conexiones"),
        ("pool_timeout_count", "f) Eventos QueuePool", "Conteo por corrida"),
    )
    fig, axes = plt.subplots(3, 2, figsize=(9.0, 7.3))
    positions = list(range(len(rows)))
    for axis, (metric, title, ylabel) in zip(axes.flat, panels):
        panel(axis, title, ylabel)
        for variant, label, color, offset in (("original", "Original", ORANGE, -0.19),
                                              ("pool", "Pool ajustado", BLUE, 0.19)):
            selected = [(index, row) for index, row in enumerate(rows) if row[f"{variant}_{metric}_median"] is not None]
            if not selected:
                continue
            mids = [row[f"{variant}_{metric}_median"] for _, row in selected]
            low = [mid - row[f"{variant}_{metric}_min"] for mid, (_, row) in zip(mids, selected)]
            high = [row[f"{variant}_{metric}_max"] - mid for mid, (_, row) in zip(mids, selected)]
            uncertainty = (low, high) if any(row[f"{variant}_repetitions"] > 1 for _, row in selected) else None
            axis.bar([index + offset for index, _ in selected], mids, width=0.34, yerr=uncertainty,
                     capsize=2, color=color, label=label)
            for (index, _), value in zip(selected, mids):
                if value == 0:
                    axis.annotate("0", (index + offset, 0), xytext=(0, 4), textcoords="offset points",
                                  ha="center", color=color, fontsize=8)
        axis.set_xticks(positions, [f"{row['level']} VUs" for row in rows])
    axes[0][0].margins(y=0.22)
    legend(axes[0][0], ncol=2, loc="upper left")
    caption = f"E2, original y variante de pool. Ventana de {rows[0]['seconds']} s por corrida."
    if all(row["original_repetitions"] == row["pool_repetitions"] == 1 for row in rows):
        caption += " Una corrida por imagen y nivel."
    save(fig, folder / "original-corregido", caption)


def generate(args, levels, records, window_rows, matched=()):
    cohorts = defaultdict(list)
    exploration = defaultdict(list)
    for row in levels:
        if args.cohort is not None and row["cohort"] != args.cohort:
            continue
        partial = (args.partial and row["experiment"] == "E2" and row["seconds"] == 90
                   and row["valid_runs"] == row["distinct_repetitions"] > 0)
        if partial or (row["comparable"] and not args.partial):
            cohorts[row["cohort"]].append(row)
        if not args.partial and row["experiment"] == "E2" and row["seconds"] < 90 and row["valid_runs"]:
            exploration[row["cohort"]].append(row)
    if args.cohort and args.cohort not in cohorts:
        if args.partial:
            raise ValueError("El perfil seleccionado no tiene réplicas válidas E2 de 90 s con números distintos.")
        raise ValueError("El perfil seleccionado no tiene niveles con tres repeticiones válidas.")
    annotations = (args.knee, args.optimum, args.limit)
    selected = [rows for rows in cohorts.values() if rows[0]["experiment"] == "E2"]
    if (any(value is not None for value in annotations) or args.refinement or args.latency_range) and len(selected) != 1:
        raise ValueError("Seleccione un perfil E2 comparable para marcar o refinar niveles.")
    for bounds in (args.knee, args.refinement, args.latency_range):
        if bounds and bounds[0] >= bounds[1]:
            raise ValueError("El intervalo debe dar las cotas en orden creciente.")

    folder = args.results / "figuras"
    plt.rcParams.update({"font.family": "DejaVu Sans", "font.size": 9, "axes.labelcolor": "#30343b"})
    if args.cohort is None:
        folder.mkdir(parents=True, exist_ok=True)
        deployment_figure(folder)
    for cohort, rows in exploration.items():
        if len(rows) >= 2:
            group = folder / f"E2-exploratorio-{cohort}"
            group.mkdir(parents=True, exist_ok=True)
            figure_e2(sorted(rows, key=lambda row: row["level"]), group, (None, None, None), exploratory=True)
    for cohort, rows in cohorts.items():
        rows.sort(key=lambda row: row["level"])
        prefix = "E2-parcial" if args.partial else rows[0]["experiment"]
        group = folder / f"{prefix}-{cohort}"
        group.mkdir(parents=True, exist_ok=True)
        if rows[0]["experiment"] == "E1":
            figure_e1(rows, group)
            continue
        measured = {row["level"] for row in rows}
        requested = [*(args.knee or []), *(point for point in (args.optimum, args.limit) if point is not None)]
        if any(point not in measured for point in requested):
            raise ValueError("Cada anotación exige un nivel medido con tres repeticiones válidas.")
        if args.knee:
            left, right = args.knee
            if not any(level < left for level in measured) or not any(level > right for level in measured):
                raise ValueError("La rodilla requiere niveles comparables antes y después del intervalo.")
        if args.optimum is not None:
            optimum = next(row for row in rows if row["level"] == args.optimum)
            if not optimum["all_valid_runs_meet_slo"] or (args.knee and args.optimum > 0.8 * args.knee[0]):
                raise ValueError("El óptimo anotado debe cumplir el SLO y el margen del 20 % si hay rodilla.")
        figure_e2(rows, group, annotations, partial=args.partial)
        added = [row["level"] for row in rows if "Refinement" in row["phases"].split(",")]
        interval = args.refinement or ((min(added), max(added)) if len(added) >= 2 else None)
        if interval:
            subset = [row for row in rows if interval[0] <= row["level"] <= interval[1]]
            if len(subset) < 2:
                raise ValueError("El refinamiento requiere al menos dos niveles comparables dentro del intervalo.")
            knee = args.knee if args.knee and interval[0] <= args.knee[0] < args.knee[1] <= interval[1] else None
            figure_refinement(subset, group, knee, partial=args.partial)
        if args.latency_range:
            left, right = args.latency_range
            subset = [row for row in rows if left <= row["level"] <= right]
            if len(subset) < 2:
                raise ValueError("La figura de latencia requiere al menos dos niveles comparables.")
            figure_latency_range(subset, group, partial=args.partial)

    visible = {row["run"]: row for row in records if row["window_start_ms"] is not None}
    if missing := set(args.pg_run).difference(visible):
        raise ValueError(f"No hay ventana medida para: {', '.join(sorted(missing))}.")
    chosen = [visible[name] for name in args.pg_run]
    if chosen:
        folder.mkdir(parents=True, exist_ok=True)
        figure_postgres(chosen, args.results, folder, window_rows)
    for run in visible.values():
        if run["action"] == "Pilot" and run["pg_samples"]:
            group = folder / run["run"]
            group.mkdir(parents=True, exist_ok=True)
            figure_postgres([run], args.results, group, window_rows, pilot=True)
    comparisons = defaultdict(list)
    for row in matched:
        if args.cohort is None or args.cohort in (row["original_cohort"], row["pool_cohort"]):
            comparisons[row["comparison"]].append(row)
    for profile, rows in comparisons.items():
        group = folder / f"Comparacion-{profile}"
        group.mkdir(parents=True, exist_ok=True)
        figure_comparison(sorted(rows, key=lambda row: row["level"]), group)
