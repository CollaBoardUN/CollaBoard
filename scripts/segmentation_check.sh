#!/bin/sh
# Verifica la matriz de segmentación de red (S3 · Network Segmentation).
#   sh scripts/segmentation_check.sh [proyecto_compose]
# Recorre los pares críticos de la matriz usando nicolaka/netshoot en el
# namespace de red de cada contenedor origen y comprueba que:
#   - Los pares autorizados conectan (ALLOW).
#   - Los pares prohibidos hacia almacenes/broker ajenos y salida a Internet fallan (DENY).
set -eu

PROJECT="${1:-}"
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
ROOT_DIR="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"

if [ -n "$PROJECT" ]; then
  exec python3 "$ROOT_DIR/security-tests/s3_segmentacion.py" --project "$PROJECT"
else
  exec python3 "$ROOT_DIR/security-tests/s3_segmentacion.py"
fi

