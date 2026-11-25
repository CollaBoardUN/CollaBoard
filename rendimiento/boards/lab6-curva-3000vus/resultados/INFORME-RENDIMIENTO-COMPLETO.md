# Informe Completo de Análisis de Rendimiento — CollaBoard Prototipo 3 (`GET /api/boards`)

**Equipo 1e · Arquitectura de Software (2026-II) · Universidad Nacional de Colombia**

---

## 1. Objetivo, alcance e hipótesis

Evaluar el comportamiento bajo carga concurrente de la funcionalidad principal de consulta de tableros (`GET https://gateway/api/boards`) sobre el stack completo del **Prototipo 3** (con los cinco patrones de seguridad activos: **S1 Secure Channel TLS 1.2/1.3**, **S2 Reverse Proxy**, **S3 Network Segmentation en 8 zonas**, **S4 JWT corto + refresh rotatorio** y **S5 RBAC + Authorizer**), con el fin de:

1. Reproducir y cuantificar el **bloqueo del pool original** (`5 + 10 = 15` conexiones SQLAlchemy).
2. Construir la **curva completa de rendimiento** (`1 → 3 000` VUs) con la misma metodología del Laboratorio 6 (`sleep(1)`, `timeout = 60 s`, 1 CPU por contenedor clave).
3. Identificar con precisión:
   - La **1ª rodilla (saturación de CPU)**,
   - El **throughput máximo observado**, y
   - La **2ª rodilla / punto de quiebre (inicio exacto de fallos)** mediante un refinamiento en pasos de 200 VUs entre `2 000` y `3 000` VUs (`2 200, 2 400, 2 600, 2 800, 3 000`).
4. Explicar la curva con **teoría de colas** (Ley de Little y Ley de Utilización) e identificar con evidencia el **cuello de botella**.

---

## 2. Entorno y condiciones de la prueba

| Parámetro | Configuración aplicada |
|---|---|
| **Host / Motor Docker** | Windows 11 · Docker Desktop Engine `29.6.1`, Compose `v5.2.0` (12 CPUs lógicas, 15,57 GiB RAM disponibles en la VM Docker) |
| **Stack desplegado** | Los 16 contenedores completos de CollaBoard P3 (`main`): `gateway`, `web-ssr`, `pixels-ui`, 6 APIs HTTP/WS, `message-worker`, 4 PostgreSQL 16, MongoDB 7 y RabbitMQ 3.13 en **8 redes Docker** (`edge` + 7 redes `internal: true`) |
| **Cuotas de recursos (curva Lab 6)** | `gateway`: **1 CPU / 512 MiB** · `collaboration-api`: **1 CPU / 512 MiB** · `board-db`: **1 CPU / 1 GiB** (`cpu_period=100000`, `cpu_quota=100000`) |
| **Generador de carga** | `grafana/k6:0.54.0` (hasta 6 CPUs) conectado a la red perimetral `collaboard_edge` atacando `https://gateway/api/boards` sobre **TLS 1.3** |
| **Patrón de carga (curva 1–3000 VUs)** | `constant-vus`: bucle `GET /api/boards (Bearer JWT)` → `sleep(1)` → repetir; `timeout: 60s`; calentamiento común de `10 VUs` durante `10 s`; pausa de enfriamiento de `10 s` entre niveles |
| **Ventanas de medición** | `30 s` por nivel en el barrido `1 → 2 000` VUs; **`60 s`** por nivel en el refinamiento `2 200 → 3 000` VUs (para permitir observar timeouts completos de `60 s`) |
| **Datos sembrados** | Usuario autenticado con **10 tableros activos** en `board-db`; el token JWT se obtiene fuera de la ventana medida para no contaminar `http_req_duration` |
| **Ajuste de borde en pruebas** | `RATE_LIMIT_API=100000r/s`, `RATE_LIMIT_API_BURST=100000`, `LIMIT_CONN_PER_IP=10000` en el override experimental, ya que todo el tráfico de k6 proviene de una sola IP; en producción se conservan `30r/s`, `burst=60` y `60` conexiones por IP |
| **Monitoreo** | `docker stats --no-stream` cada `2 s` (`gateway`, `collaboration-api`, `board-db`) y `pg_stat_activity` en `board-db` |

---

## 3. Punto de partida: bloqueo del código original (sin fix de pool)

En el código base de P3 (`colaboracion-module/app/database.py`), SQLAlchemy usa el pool por defecto (**5 conexiones persistentes + 10 de overflow = 15 conexiones totales**) mientras FastAPI ejecuta los endpoints síncronos (`def`) en un threadpool de **40 hilos**, y `GET /boards` no libera la transacción con `db.rollback()` explícito al terminar.

Al someter el código original a carga cerrada sin pausa (`E2 · Original`, 1 CPU, timeout 10 s):

| VUs | Intentadas | Éxitos | Timeouts | % Error | Throughput exitoso | TPM | Media (ms) | p95 (ms) | CPU `collab-api` | PG total / `idle in tx` | `QueuePool` timeouts |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 4 328 | 4 328 | 0 | 0,00 % | 144,27 req/s | 8 656 | 6,6 | 9,0 | 77,9 % | 2 / 1 | 0 |
| 2 | 4 870 | 4 870 | 0 | 0,00 % | **162,33 req/s** | **9 740** | 11,9 | 20,0 | 97,8 % | 3 / 2 | 0 |
| 4 | 4 237 | 4 237 | 0 | 0,00 % | 141,23 req/s | 8 474 | 27,9 | 49,0 | 99,2 % | 6 / 4 | 0 |
| 8 | 3 782 | 3 782 | 0 | 0,00 % | 126,07 req/s | 7 564 | 63,1 | 105,0 | 98,8 % | 9 / 8 | 0 |
| 16 | 2 006 | 1 990 | 16 | 0,80 % | 66,33 req/s | 3 980 | 160,8 | 197,0 | 53,4 % | **15 / 15** | 0 |
| **32** | 172 | 76 | **96** | **55,81 %** | **2,53 req/s** | **152** | 261,5 | 402,3 | **0,04 %** | **15 / 15** | **9** |

**Diagnóstico:** a partir de 16–32 VUs simultáneos, las **15/15 conexiones** quedan retenidas en estado `idle in transaction` con **0 consultas activas**; la CPU de `collaboration-api` se desploma a **0,04 %** (inanición de hilos/pool) y el 55,81 % de las peticiones vencen por timeout.

![Bloqueo del pool original a 32 VUs](graficas/figura-1-bloqueo-pool-32vus.png)

### Corrección aplicada (Variante `Pool v2`)
1. **Pool de la API dimensionado a `50` conexiones** (`pool_size=25`, `max_overflow=25`, `pool_timeout=5.0`, `pool_pre_ping=True`), superando los 40 hilos del threadpool de AnyIO.
2. **Pool independiente para el outbox** (`pool_size=2`, `max_overflow=0`) para que el despachador en segundo plano no compita con el tráfico HTTP.
3. **Liberación inmediata de la transacción** (`db.rollback()` en `list_my_boards` **después** de materializar todos los objetos `BoardOut`, evitando las consultas N+1).

![Comparativa de configuraciones en P3](graficas/figura-2-comparativa-versiones.png)

---

## 4. Curva completa de rendimiento (`1 → 3 000` VUs) y refinamiento `2 000 → 3 000` VUs

Con el fix `Pool v2` y cuotas de **1 CPU** (`gateway`, `collaboration-api`, `board-db`) sobre el stack completo P3 (`HTTPS + S1–S5`), se ejecutaron **15 niveles** desde `1` hasta `3 000` VUs, refinando en pasos de `200` VUs entre `2 000` y `3 000` para localizar el inicio exacto de los fallos:

| VUs | Ventana | Peticiones | avg (ms) | p50 (ms) | p95 (ms) | máx (ms) | **Error %** | **Throughput exitoso (req/s)** | **TPM exitosas** | CPU `collab-api` | CPU `gateway` | CPU `board-db` |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 30 s | 30 | 8,2 | 7,4 | 14,0 | 18,2 | 0,00 % | 0,99 | 59 | 5,8 % | 1,2 % | 1,5 % |
| 10 | 30 s | 300 | 16,7 | 11,0 | 47,8 | 92,2 | 0,00 % | 9,79 | 588 | 14,7 % | 1,2 % | 3,4 % |
| 50 | 30 s | 1 475 | 32,0 | 14,2 | 128,4 | 433,5 | 0,00 % | 47,65 | 2 859 | 37,3 % | 4,6 % | 10,0 % |
| 100 | 30 s | 2 785 | 93,2 | 44,1 | 371,2 | 876,4 | 0,00 % | 89,84 | 5 390 | 73,4 % | 6,0 % | 14,3 % |
| **150** | 30 s | 3 347 | **367,8** | 296,4 | **705,2** | 1 518,5 | 0,00 % | **107,54** | 6 452 | **95,6 %** | 7,0 % | 17,8 % |
| **200** | 30 s | 3 416 | **807,2** | 752,4 | **1 209,4** | 1 558,1 | 0,00 % | **106,99** | 6 419 | **100,1 %** | 6,8 % | 17,9 % |
| **300** *(1ª rodilla)* | 30 s | 3 564 | **1 613,7** | 1 577,4 | **1 962,5** | 2 880,2 | 0,00 % | **110,29** | **6 617** | **100,4 %** | 6,5 % | 19,1 % |
| 500 | 30 s | 3 841 | 3 144,6 | 3 221,1 | 3 579,0 | 3 916,3 | 0,00 % | 112,91 | 6 775 | 101,3 % | 13,9 % | 17,6 % |
| 1 000 | 30 s | 4 337 | 6 739,2 | 7 536,9 | 7 767,7 | 8 049,5 | 0,00 % | 112,76 | 6 765 | 85,0 % | 14,9 % | 19,0 % |
| **2 000** *(máx.)* | 30 s | 5 120 | 13 000,8 | 16 093,4 | 16 528,6 | 16 760,4 | 0,00 % | **113,77** | **6 826** | 96,7 % | 12,8 % | 18,4 % |
| **2 200** *(últ. limpio)* | 60 s | 8 315 | 16 212,6 | 18 061,7 | 19 171,3 | 22 491,4 | **0,00 %** | 110,85 | 6 651 | 96,3 % | 12,0 % | 18,2 % |
| **2 400** *(2ª rodilla / quiebre)* | 60 s | 8 346 | **17 347,9** | 18 918,4 | **22 559,4** | **59 997,7** | **3,71 %** | **107,12** | 6 427 | 95,7 % | 11,9 % | 19,7 % |
| 2 600 | 60 s | 8 907 | 17 248,7 | 18 295,7 | 23 001,5 | 59 997,8 | **7,83 %** | 109,45 | 6 567 | 95,9 % | 12,5 % | 19,0 % |
| 2 800 | 60 s | 9 628 | 17 101,7 | 18 273,1 | 23 462,9 | 60 001,4 | **13,73 %** | 110,73 | 6 644 | 95,9 % | 16,7 % | 19,5 % |
| 3 000 | 60 s | 10 223 | 17 007,3 | 18 158,4 | 27 183,3 | 59 998,3 | **16,78 %** | 113,42 | 6 805 | 99,8 % | 14,4 % | 19,1 % |

![Curva completa de rendimiento, rodilla y punto de quiebre (1 a 3000 VUs)](graficas/figura-3-rodilla-y-quiebre-boards-p3.png)

---

## 5. Throughput máximo observado, 1ª rodilla y 2ª rodilla (quiebre)

1. **Throughput máximo observado:** **`113,77 req/s`** (**`6 826 TPM`** exitosas HTTP 200), alcanzado en **2 000 VUs**. A partir de 150–300 VUs el sistema entra en una meseta plana entre `107` y `114 req/s` sin ganancia adicional de capacidad útil.
2. **1ª Rodilla (saturación de CPU):**
   - Bajo el criterio estricto del Laboratorio 6 (*menor nivel donde el throughput exitoso alcanza ≥ 95 % del máximo = `108,08 req/s`*), la rodilla cae en **`300 VUs`** (`110,29 req/s`, `6 617 TPM`, `CPU = 100,4 %`).
   - Físicamente, la **zona de rodilla arranca ya en `150–200` VUs**: en `150 VUs` el throughput llega a `107,54 req/s` (**94,5 %** del máximo, a solo `0,54 req/s` del umbral), la latencia promedio salta **3,9×** (`93,2 → 367,8 ms`) y `collaboration-api` alcanza **`95,6 %` de CPU** (y **`100,1 %`** en `200 VUs`).
3. **2ª Rodilla / Punto de quiebre (inicio exacto de fallos):**
   - **Último nivel libre de errores:** **`2 200 VUs`** (`0,00 %` de fallos, `110,85 req/s`, `p95 = 19,17 s`, `máx = 22,49 s`).
   - **Punto exacto de quiebre:** **`2 400 VUs`**, donde aparecen los primeros **`request timeout`** al alcanzar el límite de `60 s` (`máx = 59 997,7 ms`), con **`3,71 %`** de error y caída del throughput exitoso a `107,12 req/s`.
   - De `2 400` a `3 000` VUs los errores crecen de forma monotónica y proporcional a la sobrecarga: **`3,71 %` (2 400) → `7,83 %` (2 600) → `13,73 %` (2 800) → `16,78 %` (3 000)**.

---

## 6. Qué explica la forma de la curva (comprobación con teoría de colas)

La curva se divide en **tres regímenes bien diferenciados**, explicados por las leyes básicas de sistemas de colas:

### Régimen 1 · Tramo creciente (`1 → 150` VUs) — Ley de Little con pausa
Cada VU ejecuta una petición, espera la respuesta $R$ y duerme $Z = 1\text{ s}$. Por la **Ley de Little**, el throughput esperado es:
$$X \approx \frac{N}{R + Z} = \frac{N}{R + 1\text{ s}}$$
- A `50 VUs` ($R = 0,032\text{ s}$): predice `48,4 req/s` → medido **`47,65 req/s`**.
- A `100 VUs` ($R = 0,093\text{ s}$): predice `91,5 req/s` → medido **`89,84 req/s`**.

### Régimen 2 · Techo de capacidad y saturación sin errores (`150 → 2 200` VUs) — Ley de Utilización
Por la **Ley de Utilización** ($D = U / X$), en el tramo `50 → 300` VUs cada petición `GET /api/boards` demanda en promedio:
$$D = \frac{U_{\text{collab}}}{X} \approx \mathbf{8,67\text{ ms de CPU por petición}}$$
Con una cuota fija de **1 CPU** ($U_{\max} = 1$), el techo teórico absoluto del microservicio es:
$$X_{\max,\text{teórico}} = \frac{1}{D} = \frac{1000\text{ ms/s}}{8,67\text{ ms/req}} \approx \mathbf{115,3\text{ req/s}}$$
El máximo real observado fue **`113,77 req/s`** (**98,7 % del techo teórico**). Una vez alcanzado ese techo, todo usuario adicional se acumula en la cola y el tiempo de respuesta crece linealmente según $R \approx N / X - 1\text{ s}$:

| VUs ($N$) | $X$ medido (req/s) | $R$ esperado ($N/X - 1\text{ s}$) | $R$ medido (`avg`) |
|---:|---:|---:|---:|
| 500 | 112,91 | 3,43 s | 3,14 s |
| 1 000 | 112,76 | 7,87 s | 6,74 s |
| 2 000 | 113,77 | 16,58 s | 13,00 s |
| 2 200 | 110,85 | 18,85 s | 16,21 s |

### Régimen 3 · Punto de quiebre y fallos (`2 400 → 3 000` VUs) — Saturación de cola y timeout
A partir de **2 400 VUs**, la cola acumulada en la ráfaga inicial + las iteraciones sucesivas supera los `60 s` del timeout del cliente (`máx = 59 998–60 001 ms`). Nótese que entre `2 400` y `3 000` VUs la latencia `avg` de las respuestas completadas se estabiliza alrededor de `17,0–17,3 s` mientras el `p95` sigue creciendo (`22,6 → 27,2 s`) y la tasa de error salta de `3,71 %` a `16,78 %`: esto ocurre porque las peticiones más rezagadas son cortadas por timeout a los `60 s` y ya no logran completarse.

---

## 7. Qué genera el cuello de botella

La telemetría por contenedor demuestra sin ambigüedad que el cuello de botella **es la CPU de `collaboration-api` (1 único proceso Uvicorn / 1 CPU)**:

- **`collaboration-api`:** alcanza **95,6 % CPU** en `150 VUs` y permanece clavado en **96–101 %** hasta `3 000 VUs` (Python/FastAPI + serialización ORM/Pydantic + validación JWT en un único proceso).
- **`board-db` (PostgreSQL 16):** nunca supera el **19,7 % de CPU** en ningún nivel; la base de datos tiene > 80 % de margen libre.
- **`gateway` (Nginx 1.27 + TLS 1.3 + Reverse Proxy):** se mantiene entre **6,5 % y 16,7 % de CPU** incluso terminando TLS 1.3 y validando cabeceras/rutas para 3 000 VUs concurrentes.

**Confirmación experimental (eliminando el cuello de botella):** al retirar el límite de 1 CPU/RAM y escalar `collaboration-api` a **`WEB_CONCURRENCY=6`** (6 workers Uvicorn) + `max_connections=400` en `board-db`, el sistema soportó **2 000 VUs simultáneos sin pausa (`sleep = 0`)** con **0,00 % de errores**, multiplicando el throughput por **5,1×** (`113,8 req/s` → **`584,63 req/s` / `35 078 TPM`**), cumpliendo el SLO (`p95 ≤ 500 ms`, `p99 ≤ 1 000 ms`) hasta **128 VUs sin pausa** (`30 746 TPM`, `p95 = 436 ms`).

---

## 8. Comparativa directa: Laboratorio 6 (P2 HTTP) vs Prototipo 3 (HTTPS + S1–S5)

| VUs | Lab 6 (P2) req/s | P3 req/s | Lab 6 (P2) p95 (ms) | P3 p95 (ms) | Lab 6 CPU `collab` | P3 CPU `collab` |
|---:|---:|---:|---:|---:|---:|---:|
| 1 | 0,99 | 0,99 | 14,3 | 14,0 | 5,3 % | 5,8 % |
| 10 | 9,04 | 9,79 | 128,1 | 47,8 | 9,4 % | 14,7 % |
| 50 | 47,41 | 47,65 | 135,9 | 128,4 | 28,1 % | 37,3 % |
| 100 | 90,78 | 89,84 | 238,3 | 371,2 | 49,7 % | 73,4 % |
| 150 | 133,60 | 107,54 | 303,5 | 705,2 | 76,6 % | 95,6 % |
| 200 | 167,29 | 106,99 | 445,1 | 1 209,4 | 90,2 % | 100,1 % |
| 300 | 168,53 | 110,29 | 988,2 | 1 962,5 | 100,3 % | 100,4 % |
| 500 | 170,00 | 112,91 | 2 032,5 | 3 579,0 | 98,9 % | 101,3 % |
| 1 000 | 172,67 | 112,76 | 4 809,5 | 7 767,7 | 98,9 % | 85,0 % |
| 2 000 | 158,28 | 113,77 | 12 558,5 | 16 528,6 | 93,6 % | 96,7 % |

*Nota sobre la diferencia de techo (`~173 req/s` en Lab 6 vs `~114 req/s` en P3):* además del procesamiento adicional de P3 (TLS 1.3 en `gateway`, validación de política RBAC en `collaboration-api` y 8 redes segmentadas), Lab 6 corrió en un PC de escritorio dedicado (Ryzen 7 5800X) con generador externo, mientras que P3 corrió en una única máquina con WSL2 compartida entre los 16 contenedores y k6. En ambos casos la forma de la curva, la saturación en 1 CPU de `collaboration-api` y la ausencia de errores hasta 2 000 VUs son completamente consistentes.

---

## 9. Conclusiones y amenazas a la validez

### Conclusiones
1. **El mayor riesgo en producción no era la CPU sino el dimensionamiento del pool:** con el pool por defecto (`5 + 10`) y 40 hilos, `collaboration-api` entra en bloqueo (`idle in transaction`) desde **16–32 VUs** simultáneos. Aplicar `pool_size=25, max_overflow=25`, pool separado de outbox y `db.rollback()` tras materializar elimina el bloqueo por completo.
2. **Doble límite de capacidad con 1 CPU en P3:**
   - **Capacidad operativa recomendada (1ª rodilla):** **100–150 VUs** (`90–108 req/s`, `p95` entre `371` y `705 ms`, `0 %` errores). A partir de **150–300 VUs** la CPU de `collaboration-api` se clava en 100 % y el throughput se estanca en **`~113,8 req/s` (`6 826 TPM`)**.
   - **Límite absoluto antes de pérdida de servicio (2ª rodilla / quiebre):** **`2 200 VUs`** (`0,00 %` errores); en **`2 400 VUs`** inician los timeouts de `60 s` (`3,71 %`) y escalan hasta **`16,78 %`** en `3 000 VUs`.
3. **La seguridad de P3 (S1–S5) no es el cuello de botella:** el `gateway` (TLS 1.3 + Reverse Proxy) no supera el `16,7 %` de CPU ni a 3 000 VUs, y la segmentación S3 añade apenas `+0,15 ms` en mediana.
4. **Escalabilidad comprobada:** escalar únicamente `collaboration-api` a 6 workers (`WEB_CONCURRENCY=6`) y `board-db` a `max_connections=400` eleva la capacidad a **`584,6 req/s` (`35 078 TPM`)** y `2 000 VUs` sin pausa con `0,00 %` de errores.

### Amenazas a la validez
- Generador (`k6`) y SUT (16 contenedores) corren en el mismo host sobre Docker Desktop / WSL2 (sin latencia WAN real).
- Una sola repetición por nivel en el barrido rápido `1 → 3 000` VUs y un único patrón de consulta (`GET /api/boards` con 10 tableros por cuenta).
- El rate limiter del `gateway` se elevó para medir la capacidad interna del backend; en producción el borde limita por IP a `30 req/s` (`burst 60`).

---

## 10. Análisis de concurrencia WebSocket — `pizarra-api` (`wss://gateway/ws/boards/{id}`)

Complementariamente al estudio HTTP de `GET /api/boards`, se midió cuántos **usuarios concurrentes en tiempo real** soporta una **misma sala de pizarra** sobre `wss://gateway/ws/boards/{id}?token=JWT` (1 CPU en `pizarra-api` y `gateway`, `LIMIT_CONN_WS_PER_IP=10000`, cada VU envía `cursor` + `ping` cada `1 s` durante `20 s`).

### Tabla completa de concurrencia WebSocket (`pizarra-api`)

| VUs en la sala | Mensajes recibidos | **Throughput fan-out (msg/s)** | RTT avg (ms) | RTT p50 (ms) | **RTT p95 (ms)** | RTT máx (ms) | **Error / desconexión %** | **CPU `pizarra-api`** | CPU `gateway` | RAM máx `pizarra` (MiB) |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 27 | 1,1 | 3,0 | 1,0 | 9,0 | 25,0 | 0,00 % | 0,2 % | 0,0 % | 68,5 |
| 10 | 2 635 | 105,4 | 2,7 | 2,0 | 8,0 | 18,0 | 0,00 % | 6,1 % | 2,0 % | 69,5 |
| 25 | 16 381 | 655,2 | 4,8 | 3,0 | 11,0 | 125,0 | 0,00 % | 16,8 % | 8,6 % | 83,6 |
| **50** *(óptimo)* | 63 770 | **2 550,8** | **10,9** | 5,0 | **26,0** | 372,0 | **0,00 %** | **33,7 %** | 21,0 % | 83,6 |
| **100** *(1ª rodilla)* | 213 918 | **8 556,2** *(máx.)* | **333,5** | 281,0 | **869,0** | 998,0 | **0,00 %** | **99,0 %** | 77,1 % | 93,5 |
| **150** *(2ª rodilla / quiebre)* | 178 129 | **7 123,4** *(cae)* | 331,7 | 275,0 | 872,6 | 999,0 | **16,67 %** | **100,0 %** | 57,8 % | 98,2 |
| **200** | 158 256 | **6 321,8** *(cae)* | 330,7 | 279,0 | 844,0 | 997,0 | **38,50 %** | **99,2 %** | 57,6 % | 100,2 |

![Análisis de concurrencia WebSocket de pizarra-api](graficas/figura-9-rodilla-pizarra-ws.png)

### Lectura y cuello de botella del WebSocket de la pizarra
- **Óptimo operativo:** **50 usuarios simultáneos en la misma sala** (`2 551 msg/s`, `RTT p95 = 26 ms`, CPU `33,7 %`, `0,00 %` errores).
- **1ª Rodilla (saturación de CPU):** **100 usuarios simultáneos** — alcanza el **throughput máximo observado (`8 556,2 msg/s`)**, la CPU de `pizarra-api` llega al **99,0 %** y el RTT `p95` salta **33×** (`26 ms → 869 ms`), todavía con `0,00 %` de errores.
- **2ª Rodilla / Punto de quiebre (fallos y caída de throughput):** **150 usuarios simultáneos** — el throughput **cae** de `8 556` a `7 123 msg/s` y aparecen **`16,67 %`** de desconexiones/errores (subiendo a **`38,50 %`** en 200 VUs).
- **Qué genera el cuello de botella:** en una sola sala, el fan-out crece cuadráticamente como $O(N^2)$ ($N \times (N - 1)$ mensajes/s). Al alcanzar ~8 500 mensajes/s, el único event loop de Python/FastAPI en `pizarra-api` (1 CPU) se satura al **100 %**, mientras la memoria apenas llega a `100 MiB` (`gateway` en `58–77 %` CPU). Para escalar más allá de 100 usuarios por sala se requiere la misma táctica que aplicamos en `pixels-api` (**micro-batching de cursores/trazos** + serialización única en vez de re-serializar por cliente).
