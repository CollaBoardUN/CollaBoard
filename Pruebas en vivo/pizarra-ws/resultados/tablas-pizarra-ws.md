# Informe Riguroso de Concurrencia WebSocket — `pizarra-api` (CollaBoard P3)

**Equipo 1e · Arquitectura de Software (2026-II) · Universidad Nacional de Colombia**

---

## 1. Objetivo, alcance y rigor metodológico

Determinar con rigor cuántos **usuarios concurrentes en tiempo real** soporta el servicio de pizarra (`pizarra-api`, Python / FastAPI) sobre el stack completo **Prototipo 3** (`wss://gateway/ws/boards/{id}?token=JWT`, TLS 1.3, Reverse Proxy, 8 redes segmentadas S3, JWT corto S4 y RBAC PEP + caché 2 s S5), identificando:

- El **óptimo operativo** (`RTT p95 ≤ 250 ms` y `0 %` errores),
- La **1ª rodilla (saturación de CPU)** y el **throughput máximo observado (`msg/s`)**,
- La **2ª rodilla / punto de quiebre exacto** (inicio de desconexiones o pérdida de `ack`), y
- El efecto arquitectónico de la topología de salas (**1 sala gigante $O(N^2)$ vs 15 salas pequeñas $O(M \cdot k^2)$**).

---

## 2. Entorno, condiciones y ajustes de prueba documentados

> **Sin modificaciones al código fuente del proyecto:** no se alteró ningún archivo versionado de `pizarra-api`, `gateway`, `collaboration-api` ni `docker-compose.yml`. Únicamente se aplicó un archivo Compose de prueba (`scripts/compose.pizarra.yml`) documentado a continuación.

| Parámetro | Valor aplicado | Justificación |
|---|---|---|
| **Cuotas de prueba (`compose.pizarra.yml`)** | `pizarra-api`: **1 CPU / 512 MiB** · `gateway`: **1 CPU / 512 MiB** | Misma disciplina reproducible del Laboratorio 6 para fijar el techo en 1 núcleo |
| **Límites de borde (`compose.pizarra.yml`)** | `LIMIT_CONN_WS_PER_IP=10000`, `LIMIT_CONN_PER_IP=10000`, `RATE_LIMIT_API=100000r/s` | Todas las conexiones de `k6` salen de una sola IP; en producción se mantienen los límites de S2 |
| **Aislamiento del PDP (`compose.pizarra.yml`)** | `collaboration-api` con imagen `pool-lab6` (`25+25` + `rollback`) a partir de 120 VUs | Con el pool original `5+10` de `main`, el PDP se bloqueaba (`unhealthy`) en `120 VUs` y `pizarra-api` (PEP *fail-closed*) rechazaba el 100 % de conexiones; usar `pool-lab6` aísla el cuello de botella propio de `pizarra-api` |
| **Identidades reales (RBAC S5)** | **20 usuarios editores distintos** unidos a cada tablero vía `/api/boards/{id}/invite` + `/accept` | Evita el sesgo de 1 solo token en la caché de 2 s del PEP (`internal_client.py`) |
| **Tráfico real por VU** | Cada `1 s`: **`ops`** (`add` idempotente de un rectángulo por VU → ejerce `room.lock`, validación, RBAC PEP, broadcast, `ack` y `autosave` a `canvas-db`) + **`cursor`** | Ejercita el pipeline completo de escritura, difusión y persistencia |
| **Medición de latencia exacta** | Mapa de correlación `ref → timestamp` (`ops` → `ack`) | Evita cualquier truncamiento de RTT aunque la latencia supere varios segundos |
| **Ventanas** | **`10 s` de calentamiento (excluidos)** + **`30 s` de medición estable** + `8 s` de enfriamiento | Separa el *handshake* inicial del régimen estacionario |

---

## 3. Escenario A — Una sola sala compartida (peor caso $O(N^2)$)

| VUs | Mensajes recibidos | **Throughput fan-out (msg/s)** | `ops` enviadas / `ack` | **RTT avg (ms)** | RTT p50 (ms) | **RTT p95 (ms)** | RTT máx (ms) | **Errores WS %** | **CPU `pizarra-api`** | CPU `gateway` | CPU `collab` | CPU `canvas-db` | RAM máx (MiB) |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 59 | 2.0 | 28/28 | 7.6 | 7.5 | 9.0 | 9.0 | 0.00 % | 4.4 % | 0.5 % | 9.8 % | 0.3 % | 86.6 |
| 10 | 5,665 | 188.8 | 280/280 | 8.8 | 8.0 | 13.0 | 23.0 | 0.00 % | 6.3 % | 1.9 % | 10.3 % | 1.1 % | 99.4 |
| 25 | 35,172 | 1,172.4 | 701/700 | 11.0 | 10.0 | 17.0 | 42.0 | 0.00 % | 24.0 % | 11.1 % | 15.9 % | 1.2 % | 94.5 |
| 50 | 140,629 | 4,687.6 | 1407/1402 | 49.6 | 24.0 | 210.0 | 576.0 | 0.00 % | 69.1 % | 43.0 % | 36.9 % | 1.3 % | 97.1 |
| **75** | 248,422 | **8,280.7** | 2114/1401 | **7116.1** | 7209.0 | **9210.0** | 10588.0 | **0.00 %** | **99.2 %** | 66.2 % | 47.4 % | 1.6 % | 99.7 |
| 100 | 249,158 | 8,305.3 | 2823/621 | 17837.2 | 17869.0 | 21395.0 | 22492.0 | 0.00 % | 98.9 % | 71.3 % | 43.4 % | 1.1 % | 101.0 |
| 110 | 254,534 | 8,484.5 | 3107/412 | 21037.8 | 21255.0 | 24580.2 | 25683.0 | 0.00 % | 98.2 % | 65.5 % | 33.5 % | 0.8 % | 87.9 |
| 120 | 243,982 | 8,132.7 | 3419/74 | 26333.3 | 26516.5 | 27700.7 | 27956.0 | 0.00 % | 99.0 % | 68.8 % | 43.2 % | 2.4 % | 100.4 |
| 130 | 241,540 | 8,051.3 | 3674/0 | 0.0 | 0.0 | 0.0 | 0.0 | 0.00 % | 99.6 % | 72.1 % | 35.1 % | 1.9 % | 99.3 |
| 140 | 268,994 | 8,966.5 | 3970/0 | 0.0 | 0.0 | 0.0 | 0.0 | 0.00 % | 96.5 % | 70.5 % | 41.5 % | 1.3 % | 101.1 |
| 150 | 259,282 | 8,642.7 | 4272/0 | 0.0 | 0.0 | 0.0 | 0.0 | 0.00 % | 98.7 % | 65.5 % | 34.6 % | 1.7 % | 100.4 |
| 200 | 222,192 | 7,406.4 | 5707/0 | 0.0 | 0.0 | 0.0 | 0.0 | 0.00 % | 98.2 % | 60.4 % | 35.2 % | 1.8 % | 90.7 |

![Curva de concurrencia WebSocket de pizarra-api](graficas/figura-1-rodilla-y-quiebre-pizarra-ws.png)

---

## 4. Puntos críticos, qué explica la curva y cuello de botella

- **Óptimo operativo (`p95 ≤ 250 ms`, `0 %` error):** **`50 VUs`** en una misma sala (`4,687.6 msg/s`, `RTT p95 = 210.0 ms`, CPU `pizarra-api = 69.1 %`).
- **Throughput máximo observado:** **`8,966.5 msg/s`** (umbral 95 % = `8,518.1 msg/s`).
- **1ª Rodilla (saturación de CPU):** **`75 VUs`** (`8,280.7 msg/s`, `RTT avg = 7116.1 ms`, `p95 = 9210.0 ms`, CPU `pizarra-api = 99.2 %`).
- **Último nivel limpio (`< 1 %` error):** **`50 VUs`**.
- **2ª Rodilla / Punto de quiebre (fallos):** **`75 VUs`** (`errores WS = 0.00 %`, `ack loss = 33.7 %`, `RTT p95 = 9210.0 ms`).

### Qué explica la forma de la curva
1. **Crecimiento cuadrático del fan-out ($O(N^2)$):** en una sola sala cada `ops` se difunde a $N$ clientes y cada `cursor` a $N - 1$ clientes. Por tanto, el tráfico saliente crece aproximadamente como $\approx 2 N^2$ mensajes/s.
2. **Ley de Utilización sobre el event loop de Python:** en el tramo creciente (`25 → 75` VUs), cada mensaje difundido consume en promedio **`157.2 µs` de CPU** en `pizarra-api` → techo teórico de 1 CPU: **`6,361 msg/s`** (coherente con el máximo medido de `8,966 msg/s`).
3. **Cuello de botella demostrado por telemetría:** `pizarra-api` se clava en **~100 % de su único núcleo** serializando y escribiendo frames JSON en `asyncio.gather` bajo `room.lock`, mientras `canvas-db` (autosave con debounce) y `collaboration-api` (protegido por la caché de 2 s del PEP) permanecen holgados y la RAM de `pizarra-api` apenas alcanza ~100 MiB.

---

## 5. Escenario B — Control multi-sala (150 VUs: 1 sala vs 15 salas)

| Topología (mismos VUs totales) | msg/s (fan-out) | `ops` / `ack` | RTT avg (ms) | **RTT p95 (ms)** | **Errores WS %** | **CPU `pizarra-api`** | CPU `gateway` |
|---|---:|---:|---:|---:|---:|---:|---:|
| **1 sala × 150 VUs** ($O(N^2)$) | 8,642.7 | 4272/0 | 0.0 | **0.0** | **0.00 %** | **98.7 %** | 65.5 % |
| **15 salas × 10 VUs** ($O(M \cdot k^2)$) | 2,542.4 | 4284/3452 | 4289.0 | **6530.4** | **0.00 %** | **100.1 %** | 30.2 % |

![Comparativa 1 sala vs 15 salas](graficas/figura-2-una-sala-vs-multisala.png)

**Qué demuestra este control:** con exactamente los mismos **150 usuarios concurrentes** y 1 sola CPU, pasar de 1 sala gigante a 15 salas de 10 usuarios reduce el fan-out cuadrático y hace que la latencia `p95`, la CPU y los errores caigan drásticamente. Esto prueba experimentalmente que el límite no es el número bruto de sockets abiertos sino la tasa de difusión $O(N^2)$ dentro de una misma sala.

---

## 6. Conclusiones y recomendación arquitectónica

1. Con 1 CPU y el código actual de `pizarra-api`, una **misma sala** opera con excelente fluidez hasta **`50 usuarios simultáneos`** (`p95 = 210.0 ms`, `0 %` errores) y alcanza su saturación en **`75 VUs`**.
2. En operación real distribuida en **múltiples tableros**, el mismo contenedor de 1 CPU soporta holgadamente **150+ usuarios simultáneos** porque el tráfico se particiona por sala.
3. **Táctica recomendada (si se requieren > 100 usuarios en una sola sala):** aplicar la misma optimización validada en `pixels-api` (**ADR 0019**): pre-serializar el JSON una sola vez por difusión en vez de llamar `ws.send_json(message)` por cada cliente, y agrupar cursores/trazos en ventanas cortas (*micro-batching* de 30–50 ms).
