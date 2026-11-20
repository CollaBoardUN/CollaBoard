# ADR 0015 · Control de acceso basado en roles (RBAC) con Authorizer (PDP único en `collaboration-api` y PEPs con Cache-Aside)

- **Estado:** aceptada (escenario S5 del Prototipo 3) · **Fecha:** 2026-11-19 · **Responsable:** David Eduardo Calderón

## Contexto

En el Prototipo 2, aunque la ADR 0014 desacopló `BoardDB` (`collaboration-api`) y `CanvasDB` (`pizarra-api`), el control de acceso sobre los tableros quedó fragmentado e inconsistente entre servicios:

1. **Política dispersa sin fuente única de verdad:** las reglas de qué puede hacer un `owner`, un `editor` o un `viewer` estaban codificadas con comparaciones numéricas (`ROLE_ORDER[role] >= ROLE_ORDER[minimum]`) repartidas en cada router, sin una tabla declarativa `rol × acción`.
2. **CRUD duplicado de tableros en `pizarra-api`:** `pizarra-backend/app/main.py` seguía montando `boards.router` e `invites.router` en producción contra `CanvasDB` (que no contiene las tablas `boards` ni `board_members`), provocando errores 500 o inconsistencias si un cliente invocaba esas rutas directamente.
3. **Fallback *fail-open* crítico en `pizarra-api`:** en `pizarra-backend/app/internal_client.py`, si `COLLABORATION_API_URL` estaba vacía, `fetch_board_access()` devolvía `return True, "owner"`, otorgando privilegios de propietario a cualquier usuario autenticado.
4. **Contrato roto entre `chat-api` y `collaboration-api`:** `chat-module` consultaba `/api/boards/{id}/permissions` y `/api/boards/{id}/members` sin enviar la cabecera `X-Service-Token`, mientras que el PDP exponía `/internal/boards/{id}/access` y `/internal/boards/{id}/recipients` exigiendo dicho token. Además, `chat-api` carecía de un endpoint interno `DELETE /internal/chat/boards/{id}` para purgar mensajes y cerrar WebSockets al archivar un tablero.
5. **Ventana de revocación no acotada en WebSockets y sobrecosto por petición:** en `pizarra-api`, los eventos `draft` no revalidaban el rol del emisor y cada operación HTTP a `pizarra-api` ejecutaba una llamada HTTP síncrona sin caché hacia `collaboration-api`.

## Decisión

Adoptamos los patrones **Role-Based Access Control (RBAC)** y **Authorizer**, separando estrictamente el **Policy Decision Point (PDP)** de los **Policy Enforcement Points (PEPs)** y aplicando el patrón de rendimiento **Cache-Aside** con TTL corto:

1. **Tabla declarativa única de política RBAC en el PDP (`colaboracion-module/app/policy.py`):**
   - Se define el enumerado `Action` con las **24 acciones** del dominio de tableros (gestión de tablero, miembros, invitaciones, lienzo HTTP/WS, chat HTTP/WS y consultas internas) y la matriz inmutable `POLICY_MATRIX: dict[Role, frozenset[Action]]` para los tres roles (`owner`, `editor`, `viewer`).
   - La política se expone de forma auditable en `GET /internal/policy` y se documenta en [`docs/p3/politica-rbac.md`](../p3/politica-rbac.md).
2. **`collaboration-api` como único Policy Decision Point (PDP):**
   - Único servicio con acceso a `board-db` (`boards`, `board_members` con índice compuesto `uq_board_user (board_id, user_id)`, `invites`).
   - Evalúa decisiones para otros microservicios en `GET /internal/boards/{id}/access?action=<action>`, exigiendo autenticación entre servicios mediante `X-Service-Token` (comparado en tiempo constante con `hmac.compare_digest`) y el JWT del usuario (`Authorization: Bearer` o cookie `cb_session`).
   - Devuelve `404 Not Found` tanto cuando el tablero no existe/está archivado como cuando el usuario no es miembro (evitando enumeración de UUIDs de tableros ajenos), `403 Forbidden` cuando el usuario es miembro pero su rol no autoriza `action`, y `200 OK` con `{board_id, user_id, role, action, allowed, permissions, cache_ttl_seconds}` cuando está autorizado.
3. **Policy Enforcement Points (PEPs) con *fail-closed* y caché `Cache-Aside` (`TTL = 2 s`):**
   - **PEP local en `collaboration-api` (`app/permissions.py`):** dependencia `require_action(Action.*)` aplicada a todas las rutas de `boards.py` e `invites.py`.
   - **PEP remoto en `pizarra-api` (`app/internal_client.py`):** elimina el fallback permisivo; si falta `COLLABORATION_API_URL`, el PDP no responde o devuelve error, **deniega el acceso (*fail-closed*)**. Almacena decisiones positivas en memoria por `(board_id, sha256(token), action)` durante `AUTHZ_CACHE_TTL_SECONDS = 2.0`. Desactiva en producción `boards.router` e `invites.router` (`LEGACY_BOARDS_ROUTES_ENABLED=false`).
   - **PEP remoto en `chat-api` (`CollaborationClient.java` + `InternalChatController.java`):** consulta `/internal/boards/{id}/access?action=...` y `/internal/boards/{id}/recipients` enviando `X-Service-Token`, cachea decisiones en `ConcurrentHashMap` durante `CHAT_PERMISSION_CACHE_TTL_MS = 2000`, y expone `DELETE /internal/chat/boards/{boardId}` para invalidar caché, cerrar sockets con código `4403` y purgar mensajes cuando el PDP archiva un tablero.
4. **Revocación en caliente sobre canales WebSocket (`≤ 5 s`):**
   - `pizarra-api` revalida el rol del socket contra el PEP/PDP cada `ROLE_RECHECK_SECONDS = 2.0` y en cada frame `ops` y `draft`, cerrando el socket con `1008 Policy Violation` si el usuario fue degradado a `viewer` o expulsado.
   - `chat-api` revalida permisos cada `CHAT_RECHECK_MS = 3000` y en cada envío de mensaje, cerrando con `4403` ante revocación.

## Alternativas descartadas

| Alternativa | Por qué se descartó |
|---|---|
| **Autorizar membresía y rol en el Gateway (Nginx / `auth_request`)** | Contradice la [ADR 0006](0006-nginx-reverse-proxy-sin-logica.md): el gateway solo enruta y aplica controles de borde (TLS en S1, cabeceras y rate-limit en S2). Extraer `board_id` de rutas REST y de frames WebSocket o acoplar Nginx a `board-db` rompería la cohesión del proxy e impediría revalidar permisos dentro de conexiones WebSocket ya abiertas. |
| **Incluir la lista de tableros y roles dentro del JWT (`claims` del token de acceso)** | Los JWT son autocontenidos y en el sistema viven hasta su expiración; si un `owner` degrada a un `editor` o expulsa a un miembro, el cambio no surtiría efecto hasta que expire el JWT, violando la medida de revocación en `≤ 5 s` del escenario S5. Además, un usuario con decenas de tableros inflaría el tamaño de la cookie `cb_session` en cada petición HTTP. |
| **Replicar la tabla `board_members` en `canvas-db` y `chat-db` por eventos asíncronos** | Contradice la [ADR 0014](0014-separacion-boarddb-canvasdb.md) y reintroduce estado duplicado con riesgo de divergencia eventual si un evento falla o se retrasa. El patrón Authorizer mantiene una única fuente de verdad en `board-db`. |
| **PEP sin caché (`TTL = 0 s`, consulta síncrona al PDP en cada trazo o mensaje)** | Garantiza revocación instantánea en HTTP, pero multiplica por 20 las llamadas internas a `collaboration-api` durante ráfagas de dibujo o lectura y convierte al PDP en cuello de botella de CPU. Con `TTL = 2 s` se elimina el 95 % de las llamadas internas manteniendo la ventana de revocación muy por debajo de los `5 s` requeridos. |

## Consecuencias

- **(+)** Fuente única de verdad para la política RBAC (`app/policy.py`, 3 roles × 24 acciones) y para la membresía (`board-db`), verificada automáticamente con una matriz exhaustiva de **144 celdas** (`6 identidades × 24 operaciones`) en `security-tests/s5_rbac.py`.
- **(+)** Comportamiento estrictamente *fail-closed* en `pizarra-api` y `chat-api`, y aislamiento contra enumeración de tableros ajenos (`404 Not Found` para no-miembros).
- **(+)** Revocación efectiva en sesiones WebSocket activas en `< 1 s` tras expirar el TTL (medida en `0,67 s` para degradación y `0,56 s` para expulsión, cumpliendo el umbral `≤ 5 s`), e invalidación inmediata (`0 s`) al archivar un tablero.
- **(−)** Ventana máxima de hasta `2 s` (`TTL`) durante la cual una decisión cacheada en memoria del PEP sigue vigente tras un cambio de rol por REST; aceptada y cuantificada como *trade-off* explícito frente a la reducción del 95 % de llamadas internas al PDP.
