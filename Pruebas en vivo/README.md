# Pruebas en vivo · CollaBoard P3

Scripts individuales para demostrar en vivo cada parte de la entrega. Todos los scripts de carga con `k6` preguntan en consola **cuántos VUs** y **cuántos segundos** quieres ejecutar (o los reciben por parámetro).

## Scripts disponibles

| # | Archivo | Qué demuestra | Pide VUs en consola |
|---|---|---|---|
| 0 | `00-inspeccion-docker-arquitectura.ps1` | Muestra los 16 contenedores, puertos publicados (solo `gateway`), las 8 redes (`Internal=true`) y consumo CPU/RAM | No (inspección Docker) |
| 1 | `01-s3-segmentacion-ataque.ps1` | Simula un atacante en vivo dentro de `pixels-api` y `message-worker` | No (prueba de red) |
| 2 | `02-s3-matriz-completa.ps1` | Ejecuta la matriz automatizada de 89 caminos (`s3_segmentacion.py`: 22/22, 45/45, 8/8, 14/14) | No (matriz completa) |
| 3 | `03-perf-pixels-ws.ps1` | Prueba `k6` de WebSockets en `pixels-api` (`wss://gateway/ws/pixels`, batch `0 ms` vs `50 ms`) | **Sí** (`VUs`, `BatchMs`, `DurationS`) |
| 4 | `04-perf-segmentacion-http.ps1` | Prueba `k6` HTTP sobre `GET /api/pixels/stats` a través de las redes segmentadas | **Sí** (`VUs`, `DurationS`) |
| 5 | `05-perf-boards.ps1` | Prueba `k6` sobre `GET /api/boards` (`Original` o `Pool`, hasta `2000` VUs) | **Sí** (`VUs`, `Variant`, `DurationS`) |
| 6 | `06-resumen-pruebas-previas.ps1` | Imprime los resultados ya medidos (P2 vs P3) y abre las 5 gráficas de evidencia | No (resumen + gráficas) |

Ver también **`GUIA-SUSTENTACION.md`** con las respuestas listas sobre dockerización, tácticas de Bass, resultados y qué significan.

## Cómo ejecutarlos desde la raíz del repositorio

```powershell
# 1. Ataque en vivo desde contenedor comprometido (S3)
powershell -ExecutionPolicy Bypass -File ".\Pruebas en vivo\01-s3-segmentacion-ataque.ps1"

# 2. Matriz completa de 89 caminos (S3)
powershell -ExecutionPolicy Bypass -File ".\Pruebas en vivo\02-s3-matriz-completa.ps1"

# 3. Rendimiento WebSocket de pixels-api (te preguntará cuántos VUs)
powershell -ExecutionPolicy Bypass -File ".\Pruebas en vivo\03-perf-pixels-ws.ps1"

# 4. Rendimiento HTTP de segmentación S3 (te preguntará cuántos VUs)
powershell -ExecutionPolicy Bypass -File ".\Pruebas en vivo\04-perf-segmentacion-http.ps1"

# 5. Rendimiento GET /api/boards (te preguntará cuántos VUs y variante)
powershell -ExecutionPolicy Bypass -File ".\Pruebas en vivo\05-perf-boards.ps1"
```

También puedes pasar los VUs directamente sin que pregunte, por ejemplo:
```powershell
powershell -ExecutionPolicy Bypass -File ".\Pruebas en vivo\03-perf-pixels-ws.ps1" -Vus 1000 -BatchMs 50 -DurationS 30
```
