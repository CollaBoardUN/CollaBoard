## S5 — Role-Based Access Control (RBAC) + Authorizer (PDP único + PEPs con Cache-Aside)

Color del escenario: **rojo** (`#D62828`, relleno `#FDECEC`). Los elementos del P2 no cambian de
color (negro `#000000`); las correcciones de la línea base contra `docker-compose.yml` van en
**gris** (`#6B7280`). Nombres de servicio idénticos a `docker-compose.yml`. Todos los diagramas
se entregan en formato editable `.drawio` con coordenadas ajustadas sin solapamiento de textos ni
de cajas.

Además, como parte del reparto de líneas base (`REPARTO_P3.pdf` §2), se entrega
`base/vista-descomposicion.base.drawio` (y se incluye `base/vista-cc.base.drawio`).

---

### 1. Vista de Componentes y Conectores (`vista-cc.S5.drawio`, sobre `base/vista-cc.base.drawio`)

#### Qué cambió en el diagrama
- **Añadido:** bloque rojo **«PDP · Authorizer»** conectado a `collaboration-api`:
  *Política única RBAC (`policy.py`) · `/internal/boards/{id}/access?action=`* (ubicado en la franja libre `x=710, y=344` para no pisar la etiqueta `HTTP/REST` del conector `gateway → collaboration-api`).
- **Añadido:** bloque rojo **«PEP + Cache-Aside»** conectado a `pizarra-api`:
  *Caché decisiones (`TTL 2 s`) · `fail-closed` · `recheck WS ≤ 5 s`* (ubicado en la franja libre `x=720, y=104`, entre `auth-api` y `pizarra-api`).
- **Añadido:** bloque rojo **«PEP + Cache-Aside»** conectado a `chat-api`:
  *Caché decisiones (`TTL 2 s`) · `X-Service-Token` · `recheck WS 3 s`* (ubicado debajo de `chat-api` en `x=945, y=496`).
- **Modificado:** conectores verticales rojos `pizarra-api → collaboration-api` y `chat-api → collaboration-api` con etiqueta `HTTP :8000 · authorize(role, action)` (`X-Service-Token + Bearer JWT` hacia `/internal/boards/{id}/access` y `/recipients`).
- **Eliminado:** conector genérico `REST` sin autenticación entre `chat-api` y `collaboration-api` (`cc-66..cc-69`), y exposición del CRUD duplicado `/boards` e `/invites` en `pizarra-api`.

#### Por qué se hicieron estos cambios (justificación arquitectónica)
1. **Un único punto de decisión (Patrón *Authorizer* — PDP vs. PEP):** En el P2, `pizarra-api` tenía un fallback *fail-open* (`return True, "owner"`) y `chat-api` llamaba a rutas públicas (`/api/boards/{id}/permissions`) sin `X-Service-Token`. En la vista C&C debe quedar explícito que `collaboration-api` es el único componente que lee `board-db` y toma decisiones RBAC (**PDP**), mientras que `pizarra-api` y `chat-api` solo hacen cumplir esa decisión (**PEPs**).
2. **Mitigación del acoplamiento temporal y de rendimiento (Patrón *Cache-Aside*):** Centralizar el PDP introduce una llamada HTTP interna por operación. Mostrar el bloque `Cache-Aside (TTL 2 s)` en los dos PEPs explica visualmente cómo se elimina el 95 % de las llamadas internas al PDP manteniendo la ventana de revocación $\le 5\text{ s}$.

---

### 2. Vista de Despliegue (`vista-despliegue.S5.drawio`)

#### Qué cambió en el diagrama
- **Añadido:** junto al contenedor `collaboration-api` (`x=480, y=462`), el bloque rojo **«PDP · Authorizer»** con `POLICY_MATRIX`, `DECISION_TTL=2s` y `X-Service-Token`.
- **Añadido:** junto al contenedor `pizarra-api` (`x=480, y=562`), el bloque rojo **«PEP + Cache-Aside · Caché en proceso»** con `CACHE_TTL=2s` y `ROLE_RECHECK=2s`.
- **Añadido:** junto al contenedor `chat-api` (`x=480, y=662`), el bloque rojo **«PEP + Cache-Aside · Caché en proceso»** con `CACHE_TTL=2000ms` y `RECHECK=3000ms`.
- **Eliminado:** ninguno (no se añaden contenedores nuevos).

#### Por qué se hicieron estos cambios (justificación arquitectónica)
1. **Caché *in-process* sin contenedor adicional (Redis descartado):** En la vista de despliegue se evidencia una decisión clave de costo/complejidad: dado que el `TTL` requerido por seguridad es muy corto (`2 s`), alojar la caché de decisiones en la memoria de cada contenedor PEP (`_decision_cache` en Python y `ConcurrentHashMap` en Java) evita desplegar y operar un contenedor extra de caché distribuida y evita un salto de red adicional.
2. **Parametrización por entorno:** Las variables `AUTHZ_CACHE_TTL_SECONDS`, `CHAT_PERMISSION_CACHE_TTL_MS`, `ROLE_RECHECK_SECONDS`, `CHAT_RECHECK_MS` e `INTERNAL_SERVICE_TOKEN` permiten cambiar el `TTL` en el banco de pruebas de rendimiento (`TTL ∈ {0, 1, 5, 30} s`) sin recompilar imágenes.

---

### 3. Vista de Capas (`vista-capas.S5.drawio`)

#### Qué cambió en el diagrama
- **Modificado (espaciado):** se amplió la altura de la **Logic Tier** de `220 px` a `270 px` y se desplazó la segunda fila de servicios (`pixels-api`, `notification-api`, `message-worker`) y la **Data / Messaging Tier** `+50 px` hacia abajo para evitar cualquier solapamiento con las insignias de S5.
- **Añadido:** dentro de la **Logic Tier**, las insignias rojas **«PDP · Authorizer»** bajo `collaboration-api` y **«PEP + Cache-Aside (TTL 2 s)»** bajo `pizarra-api` y `chat-api`, junto con las flechas rojas horizontales `pizarra-api → collaboration-api` y `chat-api → collaboration-api` (`authorize(role, action) · GET /internal/boards/{id}/access`).
- **Sin cambios:** **Presentation Tier** y **Communication Tier** (`gateway`).

#### Por qué se hicieron estos cambios (justificación arquitectónica)
1. **Por qué la autorización RBAC vive en la *Logic Tier* y NO en la *Communication Tier* (`gateway`):** Conforme a las ADRs 0006 y 0015, el gateway Nginx no tiene acceso a `board-db` ni conoce la semántica de negocio de un tablero ni inspecciona frames WebSocket (`ops`, `draft`, `cursor`). Ubicar el PDP y los PEPs en la *Logic Tier* respeta la separación de responsabilidades por capas.
2. **Aislamiento de la *Data Tier*:** Muestra que dentro de la *Logic Tier* existe colaboración horizontal PEP → PDP para que únicamente `collaboration-api` consulte `board-db` en la capa de datos.

---

### 4. Vista de Descomposición (`vista-descomposicion.S5.drawio`, sobre `base/vista-descomposicion.base.drawio`)

#### Qué cambió en el diagrama
- **Entregado como línea base:** `base/vista-descomposicion.base.drawio` con los 7 subsistemas del P2 corregidos (`pixels-ui (React / Vite)` no opcional y servicios reales de notificaciones).
- **Modificado (espaciado):** se desplazaron `pizarra-api` (`+55 px`) y `notification-api` / `message-worker` (`+55 px`) hacia abajo y se ampliaron las cajas rojas a `155–160 × 44 px` para que los nombres de archivos quepan holgadamente sin desbordar.
- **Añadido:** en el subsistema **Tableros y colaboración**:
  - Bajo `collaboration-api`: módulo rojo **Política RBAC (PDP)** (`app/policy.py · /internal/policy`).
  - Bajo `pizarra-api`: módulo rojo **Caché de decisiones (PEP)** (`internal_client.py · ws.py`).
- **Añadido:** en el subsistema **Comunicación**:
  - Bajo `chat-api`: módulo rojo **Caché de decisiones (PEP)** (`CollaborationClient · InternalChat`).

#### Por qué se hicieron estos cambios (justificación arquitectónica)
1. **Alta cohesión y trazabilidad directa al código fuente:** La vista de descomposición mapea cada responsabilidad del patrón *Authorizer* a módulos de código concretos: la definición declarativa de la política (`app/policy.py`) queda encapsulada en un único módulo de `collaboration-api`, mientras que la lógica de aplicación y caché (`internal_client.py` y `CollaborationClient.java`) queda encapsulada en los módulos clientes de cada PEP.

---

### 5. Diagrama de Secuencia (`secuencia-s5.drawio`)

#### Qué cambió en el diagrama
- **Estructura en dos marcos (`Caso A` y `Caso B`) con fondo blanco en todas las etiquetas sobre las líneas de vida:**
  - **Caso A (Denegación por rol en WebSocket):** `Cliente (Viewer)` envía `{type:'ops'}` → `PEP` sufre *Cache MISS* y consulta `GET /internal/boards/{id}/access?action=canvas:edit` → `PDP` consulta `board-db` (`uq_board_user`) y evalúa `POLICY_MATRIX` → responde `200 {role:'viewer', allowed:false, ttl:2s}` → `PEP` bloquea la operación sin incrementar `seq` y devuelve `{type:'error', code:'forbidden'}`.
  - **Caso B (Degradación o expulsión en caliente sobre WebSocket abierto):** `Cliente (Owner)` ejecuta `PATCH` o `DELETE /api/boards/{id}/members/{uid}` → `PDP` actualiza `board-db` → cuando vence el `TTL` (`≤ 2 s`) o el bucle de revalidación (`ROLE_RECHECK_SECONDS = 2 s` / `CHAT_RECHECK_MS = 3 s`), el `PEP` reconsulta al `PDP` y bloquea o cierra el WebSocket con `4403` en `≤ 5 s` (medido en `0,56–0,67 s`).

#### Por qué se hizo este diagrama (justificación arquitectónica)
1. Demuestra paso a paso cómo interactúan los 6 participantes (`Viewer/Editor`, `Owner`, `gateway`, `PEP + Cache-Aside`, `PDP · POLICY_MATRIX` y `board-db`) en el tiempo y por qué la suma de `TTL de caché (2 s) + ciclo de revalidación WS (2–3 s)` garantiza matemáticamente cumplir la medida del escenario de seguridad S5 (**revocación efectiva $\le 5\text{ s}$**).
