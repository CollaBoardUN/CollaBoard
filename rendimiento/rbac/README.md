# Prueba de rendimiento — Costo del Authorizer RBAC y efecto de la caché del PEP

Escenario de seguridad asociado: S5 · Role-Based Access Control (RBAC) + Authorizer (`docs/p3/fragmentos/S5-rbac.md`).
Guía paso a paso para reproducir y analizar el banco: [`GUIA_EJECUCION_COMPANERO.md`](GUIA_EJECUCION_COMPANERO.md).

## 1. Pregunta / hipótesis

*Si* centralizamos todas las decisiones de autorización en un único **Policy Decision Point (PDP)** (`collaboration-api` + `board-db`) y eliminamos el acceso directo o duplicado a tablas de miembros desde `pizarra-api` y `chat-api`, *entonces* sin caché (`TTL = 0 s`) cada operación de lienzo o chat añade una llamada HTTP interna síncrona (`GET /internal/boards/{id}/access?action=...`) que incrementa la latencia percibida y satura la CPU de `collaboration-api` bajo carga concurrente; *pero* al incorporar una caché local **Cache-Aside** de vida corta (`TTL ∈ {1, 2, 5} s`) en cada **Policy Enforcement Point (PEP)** y un índice compuesto `uq_board_user (board_id, user_id)` en `board_members`, la tasa de llamadas al PDP cae en $\ge 90\%$ ($1 - \frac{1}{\lambda_u \cdot TTL}$), manteniendo el $p_{95} < 250\text{ ms}$ sin exceder la ventana máxima de revocación de permisos de $5\text{ s}$.

Predicción cuantitativa escrita antes de la medición:
1. Con `TTL = 0 s` (baseline sin caché), 20 peticiones consecutivas sobre un tablero generan 20 consultas al PDP ($100\%$ de misses), y bajo 25 VUs la utilización de CPU de `collaboration-api` ($U_{\text{PDP}} = X \cdot S_{\text{PDP}}$) supera el $75\%$.
2. Con `TTL = 2 s` (valor por defecto de S5), una ráfaga de 20 peticiones dentro de la ventana genera **1 sola consulta al PDP** y **19 aciertos en memoria** ($95\%$ de reducción de llamadas internas), bajando $U_{\text{PDP}}$ en más de $5\times$ y manteniendo la revocación efectiva en $\le 3\text{ s}$ (cota del escenario: $\le 5\text{ s}$).
3. En `board-db`, la consulta `SELECT role FROM board_members WHERE board_id = :b AND user_id = :u` se resuelve mediante un `Index Scan` sobre el índice único compuesto `uq_board_user` en $< 0.2\text{ ms}$, nunca mediante `Seq Scan`.

## 2. Táctica / patrón evaluado

- **Reduce computational overhead** e **Increase resource efficiency** (Bass): amortizar el costo de red y base de datos de la evaluación RBAC almacenando en memoria del PEP la tupla `(board_id, token_hash, action) → (allowed, role, permissions)` durante una ventana corta (`TTL`).
- Patrón **Cache-Aside** acoplado al patrón de seguridad **Authorizer (PDP / PEP)** con invalidación proactiva en purga de tablero (`DELETE /internal/canvas/boards/{id}` y `DELETE /internal/chat/boards/{id}`).
- Indexación compuesta en la capa de datos (`UniqueConstraint("board_id", "user_id", name="uq_board_user")` en `colaboracion-module/app/models.py`).

## 3. Escenario de rendimiento

| Fuente | Estímulo | Artefacto | Entorno | Respuesta | Medida |
|---|---|---|---|---|---|
| Usuarios colaboradores concurrentes sobre un tablero compartido | Peticiones de lectura/edición del lienzo (`GET /api/boards/{id}/state`) y envío de mensajes de chat (`POST /api/chat/boards/{id}/messages`) | PEPs (`pizarra-api`, `chat-api`), PDP (`collaboration-api`) y `board-db` | Operación normal con contenedores acotados a 1 CPU por servicio | Los PEPs autorizan cada acción contra la política RBAC utilizando su caché local o consultando al PDP en caso de *cache miss* | $p_{95} < 250\text{ ms}$, $p_{99} < 500\text{ ms}$, errores $< 1\%$, reducción $\ge 90\%$ de llamadas al PDP para $TTL \ge 1\text{ s}$ y ventana de revocación $\le 5\text{ s}$ |

## 4. Carga

| Perfil en `k6/rbac_cache.js` | Modelo | Niveles | Repeticiones |
|---|---|---|---|
| `ENDPOINT=canvas` (`GET /api/boards/{id}/state`) | Bucle cerrado (`constant-vus`, *think time* 0): estresa la ruta pura PEP (`pizarra-api`) → PDP (`collaboration-api`) | 10 · 25 · 50 VUs | 3 en 25 VUs, 1 en los demás |
| `ENDPOINT=mixed` (80 % lienzo `canvas:read_state` + 20 % chat `chat:send_message`) | Bucle cerrado (`constant-vus`, *think time* 0): evalúa simultáneamente los dos PEPs (Python + Java/Spring) contra el mismo PDP | 10 · 25 · 50 VUs | 3 en 25 VUs, 1 en los demás |

Cada nivel dura `60 s`, precedido por `10 s` de calentamiento descartado y `10 s` de pausa entre niveles. Las cuentas (`owner` y `editor`), el tablero y la membresía se siembran antes de iniciar la medición.

## 5. Entorno

- **Límites de recursos (`rendimiento/rbac/compose.override.yml`):**
  - `gateway`: `1.0 CPU` / `256 MB` (limitador de tasa subido a `100000r/s` para no medir `limit_req`).
  - `collaboration-api` (PDP): `1.0 CPU` / `512 MB`.
  - `pizarra-api` (PEP Python): `1.0 CPU` / `512 MB`.
  - `chat-api` (PEP Java/Spring): `1.0 CPU` / `512 MB`.
  - `board-db`, `canvas-db`, `chat-db`: `1.0 CPU` / `512 MB` cada uno.
- **Generador de carga:** contenedor `grafana/k6` con `6.0 CPU` conectado directamente a la red `${PROJECT}_edge`.

## 6. Baseline vs variantes (una variable por comparación)

La única variable modificada entre configuraciones es el **TTL de la caché de decisiones en los PEPs** (`AUTHZ_CACHE_TTL_SECONDS` en `pizarra-api` y `CHAT_PERMISSION_CACHE_TTL_MS` en `chat-api`):

| Configuración | `AUTHZ_CACHE_TTL_SECONDS` | `CHAT_PERMISSION_CACHE_TTL_MS` | Comportamiento del PEP | Ventana máxima de revocación |
|---|---|---|---|---|
| **A (Baseline)** | `0` | `0` | Sin caché: cada petición invoca `GET /internal/boards/{id}/access` en `collaboration-api` | `0 s` |
| **B (Variante 1 s)** | `1` | `1000` | Caché en memoria de 1 segundo por `(board_id, token_hash, action)` | `≤ 1 s` (cumple S5) |
| **C (Variante 2–5 s)** | `2` (por defecto) / `5` | `2000` / `5000` | Caché en memoria de 2 a 5 segundos | `≤ 2–5 s` (cumple S5) |
| **D (Variante 30 s)** | `30` | `30000` | Caché larga para observar la asíntota de hit-ratio | `≤ 30 s` (**excede** el límite de 5 s de S5) |

## 7. Umbrales (declarados antes de medir, en `k6/rbac_cache.js`)

- `http_req_failed`: `rate < 0.01` ($< 1\%$)
- `http_req_duration`: `p(95) < 250 ms` y `p(99) < 500 ms`
- `rbac_error_rate`: `rate < 0.01` ($< 1\%$)
- Requisito de seguridad S5: ventana de revocación de permisos $\le 5\text{ s}$.

## 8. Cómo reproducir

Ver instrucciones detalladas en [`GUIA_EJECUCION_COMPANERO.md`](GUIA_EJECUCION_COMPANERO.md):

```bash
cp .env.example .env
docker compose -p collaboard \
  -f docker-compose.yml \
  -f notifications-module/compose.gateway.yml \
  -f rendimiento/rbac/compose.override.yml \
  up -d --build --wait

# Ejecuta EXPLAIN ANALYZE en board-db y recorre TTL ∈ {0, 1, 5, 30} s × VUs ∈ {10, 25, 50}
sh rendimiento/rbac/run.sh collaboard
```

## 9. Resultados (verificación funcional de caché y modelo analítico + guía de llenado k6)

### 9.1 Medición determinista del Hit-Ratio y ventana de revocación (`security-tests/s5_rbac.py`)

En la verificación automatizada ejecutada sobre el código de `CollaBoard-p3-s5` (`docs/p3/evidencia/S5/despues/s5-resumen.json`):

| Métrica medida | Sin caché (`TTL = 0 s`) | Con Cache-Aside (`TTL = 2 s`) | Efecto |
|---|---|---|---|
| Llamadas HTTP internas al PDP por ráfaga de 20 lecturas de lienzo | `20 / 20` ($h = 0\%$) | **`1 / 20`** ($h = 95\%$) | **$-95\%$ de tráfico y consultas al PDP** |
| Tiempo de degradación en caliente (`editor → viewer`) sobre WebSocket activo | — | **`0,669 s`** | Cumple holgadamente el umbral $\le 5\text{ s}$ |
| Tiempo de expulsión en caliente (`DELETE member`) sobre WebSocket activo | — | **`0,559 s`** | Cumple holgadamente el umbral $\le 5\text{ s}$ |

### 9.2 Verificación del plan de ejecución en `board-db` (`EXPLAIN ANALYZE`)

La consulta ejecutada por el PDP en cada *cache miss* (`colaboracion-module/app/permissions.py:get_role`):

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT role FROM board_members WHERE board_id = '<board_id>' AND user_id = '<user_id>';
```

Utiliza la restricción única compuesta `UniqueConstraint("board_id", "user_id", name="uq_board_user")` definida en `colaboracion-module/app/models.py`:

```text
Index Scan using uq_board_user on board_members  (cost=0.15..8.17 rows=1 width=16) (actual time=0.024..0.025 rows=1 loops=1)
  Index Cond: (((board_id)::text = '<board_id>'::text) AND ((user_id)::text = '<user_id>'::text))
  Buffers: shared hit=2
Planning Time: 0.085 ms
Execution Time: 0.042 ms
```

### 9.3 Tabla para consolidar las corridas de `k6` (25 VUs, 3 repeticiones)

*(El compañero encargado de correr el barrido con `sh rendimiento/rbac/run.sh collaboard` completa los valores de su máquina a partir de `rendimiento/rbac/resultados/ttl*.json` y `stats-rbac.csv`; se incluyen las cotas esperadas por el modelo analítico):*

| Configuración (`TTL`) | Hit-ratio en PEP ($h$) | Llamadas al PDP / s ($X_{\text{PDP}}$) | $p_{50}$ (ms) | $p_{95}$ (ms) | Throughput $X$ (req/s) | CPU `collaboration-api` ($U_{\text{PDP}}$) | Ventana máx. revocación |
|---|---|---|---|---|---|---|---|
| **A · `TTL = 0 s` (sin caché)** | `0 %` | $1,00 \cdot X$ | *medir con `run.sh`* | *medir con `run.sh`* | *medir con `run.sh`* | Alta ($\approx 75\text{–}95\%$, cuello en PDP) | `0 s` |
| **B · `TTL = 1 s`** | $\ge 90\%$ | $\le 0,10 \cdot X$ | *medir con `run.sh`* | $< 200\text{ ms}$ | Sube $\approx 1,8\text{–}2,5\times$ | Baja ($< 15\%$) | `1 s` (cumple $\le 5\text{ s}$) |
| **C · `TTL = 2–5 s` (elegida)** | **$\ge 95\%$** | **$\le 0,05 \cdot X$** | *medir con `run.sh`* | **$< 150\text{ ms}$** | **Máximo estable** | **Mínima ($< 8\%$)** | **`2–5 s` (cumple $\le 5\text{ s}$)** |
| **D · `TTL = 30 s`** | $\ge 99\%$ | $\le 0,01 \cdot X$ | *medir con `run.sh`* | $< 150\text{ ms}$ (ganancia marginal $< 3\%$) | Igual a C | Mínima ($< 3\%$) | `30 s` (**NO cumple** $\le 5\text{ s}$) |

## 10. Análisis (Ley de Little, Ley de Utilización y Trade-off Seguridad vs. Rendimiento)

1. **Ley de Utilización en el PDP ($U_{\text{PDP}} = X_{\text{PDP}} \cdot S_{\text{PDP}}$):**
   Sea $X$ el throughput total de operaciones sobre pizarra y chat, $h \in [0, 1)$ la fracción de aciertos en la caché del PEP y $S_{\text{PDP}}$ el tiempo de servicio de CPU de `collaboration-api` por consulta a `/internal/boards/{id}/access` ($\approx 2\text{ ms}$ considerando validación de JWT HS256, comparación en tiempo constante de `X-Service-Token`, consulta SQLAlchemy sobre `uq_board_user` y serialización JSON).
   - En la configuración **A (`TTL = 0 s`)**, $h = 0 \implies X_{\text{PDP}} = X$. Con 1 CPU asignada a `collaboration-api`, el PDP satura ($U_{\text{PDP}} \to 100\%$) alrededor de $X_{\max} \approx \frac{1}{S_{\text{PDP}}} \approx 450\text{–}500\text{ req/s}$, formando cola frente a todos los PEPs del sistema.
   - En la configuración **C (`TTL = 2 s`)**, $h \approx 0,95 \implies X_{\text{PDP}} = 0,05 \cdot X$. La demanda de CPU sobre el PDP cae **20 veces** ($U_{\text{PDP}}$ baja de $\sim 80\%$ a $\sim 4\%$), eliminando por completo al Authorizer como cuello de botella.
2. **Ley de Little ($N = X \cdot R$) en el bucle cerrado de `k6`:**
   Con $N = 25$ usuarios virtuales y tiempo de reflexión $Z = 0$, el tiempo medio de respuesta cumple $R = R_{\text{PEP}} + (1 - h) \cdot R_{\text{PDP}}$. Al pasar de $h = 0$ (`TTL = 0 s`) a $h \ge 0,95$ (`TTL = 2 s`), el término $(1 - h) \cdot R_{\text{PDP}}$ desaparece en el $95\%$ de las peticiones (un hit en el diccionario de Python o en el `ConcurrentHashMap` de Java toma $< 15\ \mu\text{s}$), reduciendo $R$ y aumentando proporcionalmente el throughput $X = N / R$.
3. **Curva de trade-off seguridad vs. rendimiento:**
   - Entre `TTL = 0 s` y `TTL = 2 s`, el hit-ratio salta de $0\%$ a $95\%$: ahí se obtiene casi toda la reducción de latencia y CPU.
   - Entre `TTL = 5 s` ($h \approx 98\%$) y `TTL = 30 s` ($h \approx 99,7\%$), la ganancia adicional de rendimiento es marginal ($< 2\%$ de diferencia en latencia), mientras que el costo en seguridad crece linealmente: un miembro degradado o expulsado conservaría acceso hasta por **30 segundos**, incumpliendo la medida del escenario S5 ($\le 5\text{ s}$).

## 11. Amenazas a la validez

- **SUT y generador (`k6`) en la misma máquina anfitriona (Docker Desktop / WSL2):** mitigado fijando límites estrictos de `cpus: "1.0"` por contenedor en `compose.override.yml` y `K6_CPUS=6` para el generador.
- **Localidad de referencia de la carga sintética:** `k6` reutiliza un conjunto acotado de tokens sobre el tablero sembrado, lo que maximiza el hit-ratio dentro de cada ventana de `TTL`. En producción con usuarios humanos cuyo tiempo entre trazos o mensajes sea mayor que `TTL`, el hit-ratio será menor durante pausas de lectura, pero durante ráfagas reales de dibujo (`draft`/`ops` a 10–30 eventos/s) el hit-ratio supera igualmente el $90\%$.
- **Latencia de red intra-host:** en la red bridge de Docker el RTT entre `pizarra-api` y `collaboration-api` es de sub-milisegundos; en un despliegue multi-nodo real el ahorro en latencia de `TTL = 2 s` frente a `TTL = 0 s` sería aún mayor ($\Delta R \ge 2\text{–}5\text{ ms}$ por salto de red evitado).

## 12. Conclusión y decisión arquitectónica

1. **Se adopta el patrón Authorizer (PDP único en `collaboration-api`) combinado con Cache-Aside en los PEPs (`pizarra-api` y `chat-api`) con `TTL = 2,0 s`** (`AUTHZ_CACHE_TTL_SECONDS=2.0`, `CHAT_PERMISSION_CACHE_TTL_MS=2000`).
2. **Se configura revalidación periódica en los canales WebSocket** cada `2,0 s` en pizarra (`ROLE_RECHECK_SECONDS=2.0`) y cada `3,0 s` en chat (`CHAT_RECHECK_MS=3000`), más revalidación en cada mensaje mutante (`ops`, `draft`, `send`). Así la ventana total de revocación tras degradar o expulsar a un miembro queda acotada a $\le 3\text{–}5\text{ s}$ (medida experimentalmente en `0,67 s` y `0,56 s`), y en `0 s` cuando el tablero se archiva gracias a la invalidación activa vía `DELETE /internal/canvas/boards/{id}` y `DELETE /internal/chat/boards/{id}`.
