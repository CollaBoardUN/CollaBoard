# Contrato interno de Colaboración y separación de identidad (Paquete B)

Autor: **David Eduardo Calderón Parra (Paquete B)**  
Servicios cubiertos: `colaboracion-module` (Python / FastAPI, dueño exclusivo de **BoardDB**) y `authentication-module` (Go / Chi, dueño exclusivo de **UserDB**).

---

## 1. Propiedad de datos y bases separadas

| Almacén | Servicio Compose | Motor | Dueño único | Tablas / Esquema | Migración propietaria |
|---|---|---|---|---|---|
| **D1 · UserDB** | `user-db` | PostgreSQL 16 | `authentication-backend` (Go) | `auth.users`, `goose_db_version` | `authentication-module/internal/database/migrations/00001_create_auth_users.sql` |
| **D2 · BoardDB** | `board-db` | PostgreSQL 16 | `colaboracion-backend` (Python) | `boards`, `board_members`, `board_invites`, `outbox_events` | `colaboracion-module/migrations/versions/0001_*.py` y `0002_ciclo_de_vida_y_outbox.py` |
| **D3 · CanvasDB** | `canvas-db` | PostgreSQL 16 + JSONB | `pizarra-backend` (Python) | `board_states`, `board_versions`, `purged_boards` | `pizarra-module/pizarra-backend/migrations/versions/0001_canvasdb_init.py` (Estefan) |

- **Cero claves foráneas entre bases de datos** y **cero migraciones duplicadas**: se eliminó de `colaboracion-module` la migración `0002_persistencia.py` (que pertenecía a Pizarra).
- El script repetible [`scripts/migrate_p1_to_userdb_boarddb.py`](../../scripts/migrate_p1_to_userdb_boarddb.py) copia usuarios hacia `user-db` sin regenerar UUIDs ni alterar hashes Argon2id, y copia tableros/miembros/invitaciones hacia `board-db`.

---

## 2. Autenticación y sesión (Bearer + Cookie `cb_session`)

Tanto `authentication-module` (`/auth/me`) como `colaboracion-module` aceptan:

1. `Authorization: Bearer <JWT>` (cliente local Electron, BFF de Next.js y llamadas internas entre servicios).
2. Cookie HttpOnly `cb_session=<JWT>` (navegador web SSR y handshake WebSocket del navegador).

**Reglas de validación:**
- Algoritmo `HS256` con `JWT_SECRET` compartido; `sub` obligatorio (UUID de usuario); si viene `iss`, debe coincidir con `JWT_ISSUER` (`collaboard-auth`).
- Cuando la petición HTTP se autentica mediante la cookie `cb_session` en un método que modifica estado (`POST`, `PATCH`, `PUT`, `DELETE`), `colaboracion-module` exige que la cabecera `Origin` esté en `ALLOWED_ORIGINS` (`403` en caso contrario).
- Todas las respuestas incluyen `X-Request-Id` y dejan registro correlacionado en logs sin exponer tokens.

---

## 3. Endpoints internos de Colaboración (`/internal/*`)

> **Seguridad:** El API Gateway bloquea `/internal/*` hacia el exterior (`404`). En la red interna, los servicios llamadores (`pizarra-backend`, `chat-api`) envían `X-Service-Token: ${INTERNAL_SERVICE_TOKEN}` y el JWT del usuario en `Authorization: Bearer <JWT>`. **El llamador no puede sustituir `user_id` cuando envía el JWT del usuario.**

### 3.1 `GET /internal/boards/{board_id}/access`

Resuelve si el tablero existe, está activo y qué rol tiene el usuario autenticado.

- **Cabeceras requeridas:**
  - `X-Service-Token: <INTERNAL_SERVICE_TOKEN>`
  - `Authorization: Bearer <JWT del usuario>` (también compatible con `X-User-Id` + `?user_id=` de `pizarra-backend` cuando presenta `X-Service-Token` válido).
- **Respuestas:**
  - `200 OK`:
    ```json
    {
      "board_id": "31b6cc68-118d-4195-8490-940203f8e18d",
      "board_name": "Arquitectura P2",
      "owner_id": "550e8400-e29b-41d4-a716-446655440000",
      "user_id": "1360536d-f69b-41f4-94fd-c8e25b971365",
      "role": "editor",
      "exists": true,
      "board_status": "active"
    }
    ```
  - `404 Not Found` (`{"detail": "Tablero no encontrado"}`): el tablero no existe, fue eliminado/desactivado (`status != "active"`) o el usuario ya no es miembro.
  - `401 Unauthorized`: token o credencial de servicio inválida/ausente.

### 3.2 `GET /internal/boards/{board_id}/recipients?exclude={actor_id}`

Devuelve la lista de miembros actuales autorizados a recibir notificaciones de un evento en el tablero, excluyendo siempre al actor.

- **Cabeceras requeridas:** `X-Service-Token` + `Authorization: Bearer <JWT del miembro>`.
- **Respuestas:**
  - `200 OK`:
    ```json
    {
      "board_id": "31b6cc68-118d-4195-8490-940203f8e18d",
      "board_name": "Arquitectura P2",
      "owner_id": "550e8400-e29b-41d4-a716-446655440000",
      "recipient_ids": ["550e8400-e29b-41d4-a716-446655440000"]
    }
    ```
  - `404 Not Found`: el tablero no existe/está inactivo o quien consulta no es miembro.

### 3.3 `PATCH /internal/boards/{board_id}/metadata`

Callback invocado por `pizarra-backend` (`notify_board_saved`) tras persistir un snapshot en CanvasDB.

- **Cuerpo:**
  ```json
  {
    "element_count": 18,
    "seq": 42,
    "state_hash": "a8f5...",
    "saved_at": "2026-10-30T20:15:00Z"
  }
  ```
- **Respuestas:**
  - `204 No Content`: actualiza `last_saved_at` y `updated_at` del tablero activo.
  - `404 Not Found`: el tablero no existe o está en `deleting`/`deleted` (un autosave tardío **nunca** resucita un tablero eliminado).

---

## 4. Evento asíncrono `invite.accepted` (Outbox transaccional)

Cuando un usuario acepta una invitación (`POST /invites/{token}/accept`) y se crea su membresía o sube de rol (`viewer -> editor`):

1. En la **misma transacción SQL** sobre `BoardDB`, se inserta un registro en `outbox_events` (`kind="notification.event"`, `status="pending"`).
2. El destinatario elegido para el escenario mínimo es explícitamente el **propietario del tablero** (`recipient_ids: [board.owner_id]`). Si el propietario abre su propio enlace, no se emite evento.
3. El despachador en segundo plano (`app/outbox.py`) envía `POST {NOTIFICATIONS_URL}/internal/events` con cabecera `X-Service-Token` y conserva **exactamente el mismo `event_id`** en todos los reintentos con *backoff* exponencial:
   ```json
   {
     "event_id": "evt-invite-7c9e6679-7425-40de-944b-e07fc1f90ae7",
     "type": "invite.accepted",
     "occurred_at": "2026-10-30T20:20:00Z",
     "actor_id": "1360536d-f69b-41f4-94fd-c8e25b971365",
     "board_id": "31b6cc68-118d-4195-8490-940203f8e18d",
     "recipient_ids": ["550e8400-e29b-41d4-a716-446655440000"],
     "payload": {
       "board_name": "Arquitectura P2",
       "actor_name": "Beto Ruiz",
       "role": "editor"
     }
   }
   ```
4. Si `NotificationAPI` está caída, la aceptación de la invitación **no se revierte** (`200 OK`) y el evento queda `pending` hasta que el servicio responda `202 Accepted` (o `409 Conflict` si ya había sido registrado).

---

## 5. Máquina de estados de borrado coordinado (`DELETE /boards/{board_id}`)

```
[ active ] ──(DELETE /boards/{id} por owner)──► [ deleting ] ──(Canvas 204/404 y Chat 204/404)──► [ deleted ]
```

1. **`active -> deleting` (atómico en `BoardDB`):**
   - Cambia `boards.status = "deleting"` y registra `deleted_at`.
   - Revoca todos los enlaces de invitación del tablero.
   - Bloquea de inmediato cualquier consulta en `GET /boards`, `GET /boards/{id}`, `/invites/{token}` y `/internal/boards/{id}/*` (responden `404`).
   - Encola en `outbox_events` dos tareas idempotentes:
     - `cleanup.canvas`: `DELETE {PIZARRA_INTERNAL_URL}/internal/canvas/boards/{board_id}`
     - `cleanup.chat`: `DELETE {CHAT_INTERNAL_URL}/internal/chat/boards/{board_id}`
2. **`deleting -> deleted`:**
   - El despachador ejecuta y reintenta ambas llamadas con `X-Service-Token`.
   - Solo cuando **ambas** tareas quedan confirmadas (`200`/`202`/`204`/`404`), el tablero pasa a `status = "deleted"`.
