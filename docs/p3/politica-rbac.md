# Política única de control de acceso basado en roles (RBAC) — Escenario S5

**Patrón:** *Role-Based Access Control (RBAC)* + *Authorizer (Policy Decision Point – Policy Enforcement Point)*  
**Tácticas (Bass):** *Authorize actors*, *Limit access*  
**Fuente de verdad en código:** [`colaboracion-module/app/policy.py`](../../colaboracion-module/app/policy.py) (`POLICY_MATRIX`)

---

## 1. Principios de la política

1. **Punto único de decisión (PDP):** `collaboration-api` (`colaboracion-module`) es el único componente que almacena y evalúa la relación `(board_id, user_id) -> role` y la tabla declarativa `POLICY_MATRIX: Action -> Set[Role]`.
2. **Puntos de aplicación desacoplados (PEPs):**
   - `collaboration-api` aplica la política localmente mediante la dependencia `require_action(Action.<accion>)`.
   - `pizarra-api` y `chat-api` actúan como PEPs puros: **no consultan `BoardDB` ni mantienen reglas propias**. Consultan `GET /internal/boards/{board_id}/access?action=<accion>` enviando `X-Service-Token` y el JWT del usuario, y cachean la decisión firmada por el PDP durante `AUTHZ_CACHE_TTL_SECONDS` (`2 s` por defecto).
3. **No filtración de existencia (404 vs 403):**
   - Si el tablero no existe, está inactivo (`status != "active"`) o el usuario autenticado **no es miembro** (incluyendo a un miembro recién expulsado), todos los puntos REST responden **`404 Not Found` (`{"detail": "Tablero no encontrado"}`)** y los WebSockets cierran con **`4403`**. Un atacante autenticado no puede distinguir un tablero ajeno de uno inexistente.
   - Si el usuario **sí es miembro** del tablero pero su rol no tiene concedida la acción solicitada en `POLICY_MATRIX`, los puntos REST responden **`403 Forbidden`** y el WebSocket de Pizarra responde `{"type": "error", "code": "forbidden"}` (sin aplicar la operación ni incrementar `seq`).
4. **Falla cerrada (*Fail-Closed*):** si el PDP (`collaboration-api`) no responde o devuelve error `5xx`, los PEPs (`pizarra-api` y `chat-api`) rechazan cualquier nueva operación o conexión (`404`/`503` en REST y cierre `4403`/`1011` en WS). Nunca se concede un rol por defecto.

---

## 2. Inventario completo de operaciones y matriz `Acción × Identidad`

Identidades evaluadas en la matriz:
- **`owner`**: creador y propietario único del tablero.
- **`editor`**: colaborador con permiso de edición sobre el lienzo y versiones manuales.
- **`viewer`**: colaborador de solo lectura en el lienzo, con participación en cursores y chat.
- **`no_miembro`**: usuario autenticado válido que nunca perteneció al tablero.
- **`expulsado`**: usuario autenticado que fue miembro y fue retirado (`DELETE /members/{uid}`).
- **`anonimo / exp`**: petición sin JWT o con JWT expirado / firma inválida.

| # | Acción RBAC | Servicio (PEP) | Ruta pública / Mensaje WS | `owner` | `editor` | `viewer` | `no_miembro` | `expulsado` | `anonimo / exp` |
|---|---|---|---|---|---|---|---|---|---|
| 1 | `board:view` | `collaboration-api` | `GET /api/boards/{id}` | `200` | `200` | `200` | `404` | `404` | `401` |
| 2 | `board:rename` | `collaboration-api` | `PATCH /api/boards/{id}` | `200` | `403` | `403` | `404` | `404` | `401` |
| 3 | `board:delete` | `collaboration-api` | `DELETE /api/boards/{id}` | `204` | `403` | `403` | `404` | `404` | `401` |
| 4 | `member:list` | `collaboration-api` | `GET /api/boards/{id}/members` | `200` | `200` | `200` | `404` | `404` | `401` |
| 5 | `member:manage` | `collaboration-api` | `PATCH /api/boards/{id}/members/{uid}` | `200` | `403` | `403` | `404` | `404` | `401` |
| 6 | `member:manage` | `collaboration-api` | `DELETE /api/boards/{id}/members/{otro}` | `204` | `403` | `403` | `404` | `404` | `401` |
| 7 | `member:leave` | `collaboration-api` | `DELETE /api/boards/{id}/members/{propio}` | `400` | `204` | `204` | `404` | `404` | `401` |
| 8 | `invite:create` | `collaboration-api` | `POST /api/boards/{id}/invite` | `201` | `403` | `403` | `404` | `404` | `401` |
| 9 | `invite:list` | `collaboration-api` | `GET /api/boards/{id}/invites` | `200` | `403` | `403` | `404` | `404` | `401` |
| 10 | `invite:revoke` | `collaboration-api` | `DELETE /api/boards/{id}/invites/{iid}` | `204` | `403` | `403` | `404` | `404` | `401` |
| 11 | `canvas:view` | `pizarra-api` | `GET /api/canvas/boards/{id}/state` | `200` | `200` | `200` | `404` | `404` | `401` |
| 12 | `canvas:version:list` | `pizarra-api` | `GET /api/canvas/boards/{id}/versions` | `200` | `200` | `200` | `404` | `404` | `401` |
| 13 | `canvas:version:read` | `pizarra-api` | `GET /api/canvas/boards/{id}/versions/{vid}` | `200` | `200` | `200` | `404` | `404` | `401` |
| 14 | `canvas:version:create` | `pizarra-api` | `POST /api/canvas/boards/{id}/versions` | `201` | `201` | `403` | `404` | `404` | `401` |
| 15 | `canvas:version:rename` | `pizarra-api` | `PATCH /api/canvas/boards/{id}/versions/{vid}` | `200` | `200` | `403` | `404` | `404` | `401` |
| 16 | `canvas:version:restore` | `pizarra-api` | `POST /api/canvas/boards/{id}/versions/{vid}/restore` | `200` | `200` | `403` | `404` | `404` | `401` |
| 17 | `canvas:version:delete` | `pizarra-api` | `DELETE /api/canvas/boards/{id}/versions/{vid}` | `204` | `403` | `403` | `404` | `404` | `401` |
| 18 | `canvas:view` (WS) | `pizarra-api` | `WS /ws/boards/{id}` (handshake + `sync`) | `sync` | `sync` | `sync` | `4403` | `4403` | `4401` |
| 19 | `canvas:cursor` (WS) | `pizarra-api` | `WS /ws/boards/{id}` `{"type":"cursor"}` | `relay` | `relay` | `relay` | `4403` | `4403` | `4401` |
| 20 | `canvas:draft` (WS) | `pizarra-api` | `WS /ws/boards/{id}` `{"type":"draft"}` | `relay` | `relay` | `ignorado` | `4403` | `4403` | `4401` |
| 21 | `canvas:edit` (WS) | `pizarra-api` | `WS /ws/boards/{id}` `{"type":"ops"}` | `ack+ops` | `ack+ops` | `error:forbidden` | `4403` | `4403` | `4401` |
| 22 | `chat:read` | `chat-api` | `GET /api/chat/boards/{id}/messages` | `200` | `200` | `200` | `404` | `404` | `401` |
| 23 | `chat:send` | `chat-api` | `POST /api/chat/boards/{id}/messages` | `201` | `201` | `201` | `404` | `404` | `401` |
| 24 | `chat:connect` (WS) | `chat-api` | `WS /ws/chat/boards/{id}` | `101+pong` | `101+pong` | `101+pong` | `4403` | `4403` | `4401` |

> **Nota sobre `pixels-api`:** El lienzo de Pixels (`/api/pixels/*`, `/ws/pixels`) es público y global por definición funcional del sistema; su control de abuso se rige por *cooldown* por cliente y no por membresía de tablero.
