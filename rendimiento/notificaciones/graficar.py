#!/usr/bin/env python3
"""Gráficas de rendimiento a partir del CSV de mediciones."""
import csv
from collections import defaultdict
from pathlib import Path
from statistics import median

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

base = Path(__file__).resolve().parent
results = base / "results"

with (results / "resumen.csv").open(newline="", encoding="utf-8") as f:
    rows = list(csv.DictReader(f))

for campo, titulo, archivo in [
    ("p95_ms", "Latencia p95 de aceptación HTTP (ms)", "p95_vs_workers.png"),
    ("requests_per_second", "Solicitudes HTTP por segundo", "rps_vs_workers.png"),
]:
    fig, ax = plt.subplots(figsize=(9, 5))

    for delay in sorted({int(r["delay_ms"]) for r in rows}):
        grupos = defaultdict(list)

        for r in rows:
            if int(r["delay_ms"]) == delay:
                grupos[int(r["workers"])].append(float(r[campo]))

        xs = sorted(grupos)
        ys = [median(grupos[x]) for x in xs]

        ax.plot(xs, ys, marker="o", label=f"Retraso {delay} ms")

        for workers, valores in grupos.items():
            ax.scatter(
                [workers] * len(valores),
                valores,
                alpha=0.5,
                s=25,
            )

    ax.set_xticks([1, 2, 4])
    ax.set_xlabel("Número de workers")
    ax.set_ylabel(titulo)
    ax.set_title(titulo + " — 500 eventos, 25 VUs, prefetch 1")
    ax.grid(alpha=0.3)
    ax.legend()
    fig.tight_layout()

    salida = results / archivo
    fig.savefig(salida, dpi=160)
    plt.close(fig)
    print("Gráfica generada:", salida)
