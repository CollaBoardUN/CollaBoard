# Guía paso a paso para ejecutar la prueba de rendimiento S5 (Costo del Authorizer y efecto de la caché del PEP)

> **Para reproducir la prueba de rendimiento de S5:**
> Toda la infraestructura del escenario **S5 — Role-Based Access Control (RBAC) + Authorizer** ya está implementada y parametrizada por variables de entorno (`AUTHZ_CACHE_TTL_SECONDS` en `pizarra-api`, `CHAT_PERMISSION_CACHE_TTL_MS` en `chat-api`, `AUTHZ_DECISION_TTL_SECONDS` en `collaboration-api`).
> Además, ya dejamos listos en esta carpeta (`rendimiento/rbac/`) el archivo `compose.override.yml`, el script de carga `k6/rbac_cache.js`, el orquestador `run.sh` y la plantilla completa de 12 secciones en `README.md`.

---

## 1. Qué mide esta prueba y cuál es el diseño experimental

Cuando centralizamos la autorización en un **Policy Decision Point (PDP)** único (`collaboration-api`), cada petición a los **Policy Enforcement Points (PEPs)** (`pizarra-api` y `chat-api`) requeriría un salto HTTP interno adicional (`GET /internal/boards/{id}/access?action=...`) más un `SELECT role FROM board_members WHERE board_id = :b AND user_id = :u` en `board-db`.

Para recuperar ese sobrecosto aplicamos el patrón **Cache-Aside** en memoria dentro de cada PEP:
- En `pizarra-api`: diccionario en memoria indexado por `(board_id, sha256(token), action)` con `AUTHZ_CACHE_TTL_SECONDS` (por defecto `2.0` s).
- En `chat-api`: `ConcurrentHashMap` indexado por `(boardId, sha256(token), action)` con `CHAT_PERMISSION_CACHE_TTL_MS` (por defecto `2000` ms).

### Configuraciones a comparar (una sola variable por comparación: `TTL`)

| Configuración | `AUTHZ_CACHE_TTL_SECONDS` | `CHAT_PERMISSION_CACHE_TTL_MS` | Qué representa | Ventana máxima de revocación |
|---|---|---|---|---|
| **A (Baseline sin caché)** | `0` | `0` | Cada petición en `pizarra-api`/`chat-api` consulta síncronamente al PDP (`collaboration-api` + `board-db`) | `0 s` (inmediata en HTTP) |
| **B (Variante TTL = 1 s)** | `1` | `1000` | Caché corta de alta frescura | `≤ 1 s` |
| **C (Variante TTL = 2–5 s)** | `5` (o `2`, valor por defecto del repo) | `5000` (o `2000`) | Punto de equilibrio seguridad vs. rendimiento | `≤ 5 s` (cumple la medida del escenario S5) |
| **D (Variante TTL = 30 s)** | `30` | `30000` | Caché larga (cota asintótica de hit-ratio) | `≤ 30 s` (**viola** la medida de revocación `≤ 5 s` de S5) |

---

## 2. Cómo ejecutar la prueba completa automáticamente

Desde una terminal con Docker Desktop activo (preferiblemente Git Bash o WSL2 en la raíz del repositorio):

```bash
# 1. Copiar variables de entorno por defecto si no existe .env
cp .env.example .env

# 2. Levantar el sistema con los límites de CPU/RAM del banco de pruebas (1 CPU por servicio, rate-limit desactivado)
docker compose -p collaboard \
  -f docker-compose.yml \
  -f notifications-module/compose.gateway.yml \
  -f rendimiento/rbac/compose.override.yml \
  up -d --build --wait

# 3. Ejecutar el barrido completo (TTLs: 0, 1, 5, 30 s × niveles: 10, 25, 50 VUs, con 3 repeticiones en 25 VUs)
sh rendimiento/rbac/run.sh collaboard
```

> **Tip para una corrida rápida de verificación (~3 minutos):**
> Puedes reducir la duración y niveles con variables de entorno antes de lanzar la corrida completa de 60 s:
> ```bash
> DURATION=20s PAUSE=3 VUS_LEVELS="10 25" KEY_VUS="25" REPS=1 sh rendimiento/rbac/run.sh collaboard
> ```

---

## 3. Qué archivos genera `run.sh` en `rendimiento/rbac/resultados/`

1. **`explain-uq-board-user.txt`**:
   Salida real de PostgreSQL (`board-db`) para:
   ```sql
   EXPLAIN (ANALYZE, BUFFERS)
   SELECT role FROM board_members WHERE board_id = '<board_id>' AND user_id = '<editor_id>';
   ```
   Verifica que PostgreSQL utiliza un **`Index Scan using uq_board_user on board_members`** ($O(\log N)$, tiempo de ejecución `< 0.1 ms`, 2 buffers leídos) y **no** un `Seq Scan`.
2. **`index-rbac.csv`**:
   Índice con `(ttl_s, endpoint, vus, rep, start_epoch, end_epoch, file)` para cruzar cada corrida con las muestras de CPU.
3. **`stats-rbac.csv`**:
   Muestreo cada 1 segundo de `docker stats` (`cpu_pct`, `mem`) para `gateway`, `collaboration-api`, `pizarra-api`, `chat-api` y `board-db`.
4. **`ttl<T>s-<endpoint>-vus<V>-r<R>.json`**:
   Resumen exportado por `k6` (`--summary-export`) con `p(50)`, `p(95)`, `p(99)` de `http_req_duration`, `rbac_canvas_read_ms`, `rbac_chat_post_ms`, `http_reqs.rate` (throughput $X$) y `http_req_failed`.

---

## 4. Cómo calcular las métricas y leyes analíticas para la ficha (`README.md`)

En el informe final (secciones 9 y 10 de `rendimiento/rbac/README.md`) debes reportar y contrastar los datos medidos con tres relaciones analíticas vistas en clase:

### 4.1 Tasa de llamadas internas al PDP y Hit-Ratio ($h$)
Para un usuario activo que realiza $\lambda_u$ operaciones por segundo sobre el mismo tablero y acción:
- Con $TTL = 0\text{ s}$ (sin caché): el PEP hace **1 llamada al PDP por cada petición** ($h = 0\%$, tasa al PDP $= X$).
- Con $TTL > 0\text{ s}$: el PEP hace como máximo $1 / TTL$ llamadas por segundo por tupla `(board_id, user, action)`. El hit-ratio teórico es:
  $$h \approx 1 - \frac{1}{\lambda_u \cdot TTL}$$
  Por ejemplo, si cada VU hace $\lambda_u = 10\text{ req/s}$:
  - Para $TTL = 1\text{ s}$: $h \approx 90\%$ (reduce las llamadas al PDP en $10\times$).
  - Para $TTL = 2\text{ s}$: $h \approx 95\%$ (reduce las llamadas al PDP en $20\times$).
  - Para $TTL = 5\text{ s}$: $h \approx 98\%$ (reduce las llamadas al PDP en $50\times$).
  - Para $TTL = 30\text{ s}$: $h \approx 99.7\%$.

### 4.2 Ley de Utilización en el PDP (`collaboration-api`)
$$U_{\text{PDP}} = X_{\text{PDP}} \cdot S_{\text{PDP}} = X \cdot (1 - h) \cdot S_{\text{PDP}}$$
Donde:
- $X$ es el throughput total servido por `pizarra-api` + `chat-api` (req/s).
- $X_{\text{PDP}} = X \cdot (1 - h)$ es la tasa de peticiones que llegan a `GET /internal/boards/{id}/access`.
- $S_{\text{PDP}}$ es el tiempo de servicio de CPU de `collaboration-api` por decisión de autorización ($\approx 1.8 - 2.5\text{ ms}$ en FastAPI + SQLAlchemy).
- Sin caché ($h = 0$), a $X \approx 400\text{ req/s}$ el contenedor `collaboration-api` (limitado a 1 CPU) alcanza $U_{\text{PDP}} \approx 100\%$ y se convierte en el cuello de botella del sistema. Con $TTL \ge 1\text{ s}$ ($h \ge 90\%$), $U_{\text{PDP}}$ cae por debajo del $15\%$ y el cuello de botella vuelve a ser el servicio de dominio (`pizarra-api` / `chat-api`).

### 4.3 Ley de Little ($N = X \cdot R$)
Con un bucle cerrado de $N$ usuarios virtuales (`constant-vus`) y tiempo de reflexión cero ($Z = 0$):
$$R = \frac{N}{X}$$
Al activar la caché del PEP ($TTL \ge 1\text{ s}$), se elimina el RTT interno + tiempo en cola del PDP ($\Delta R_{\text{PDP}}$), por lo que el tiempo de respuesta medio $R$ cae y el throughput $X = N / R$ sube proporcionalmente.

---

## 5. Gráfica recomendada (Curva de Trade-off Seguridad vs. Rendimiento)

Para el informe, grafica en el eje horizontal el **$TTL \in \{0, 1, 2, 5, 30\}\text{ s}$** (que es exactamente la **ventana máxima de revocación de permisos en segundos**) y en dos ejes verticales:
1. **Latencia $p_{95}$ (ms)** y **CPU de `collaboration-api` (%)** (curvas decrecientes que muestran un codo pronunciado entre $0\text{ s}$ y $2\text{ s}$ y rendimientos marginales decrecientes después de $5\text{ s}$).
2. **Ventana de exposición tras revocación (s)** (recta $y = TTL$, marcando la línea roja del requisito de seguridad S5 en $y = 5\text{ s}$).

Esa gráfica justifica cuantitativamente por qué elegimos **$TTL = 2\text{ s}$** en producción: captura **$\ge 95\%$** del beneficio de rendimiento en latencia y descarga de CPU del PDP, manteniendo la ventana de revocación muy por debajo del umbral de $5\text{ s}$.
