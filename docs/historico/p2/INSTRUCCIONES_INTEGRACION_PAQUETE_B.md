# Instrucciones de integración para los demás módulos (cambios de David — Paquete B)

Este documento resume exactamente qué variables, rutas y pequeños ajustes necesitan los módulos de **Estefan (D)**, **Marlon (C)**, **Cristian (E)** y **Sebastian (F)** para conectarse con los cambios entregados en `Solucion/` (`colaboracion-module`, `authentication-module` y `scripts/migrate_p1_to_userdb_boarddb.py`).

---

## 1. Para Sebastian (Paquete F: Gateway, Docker Compose y CI)

### 1.1 Servicios de base de datos separados (`user-db` y `board-db`)

En el `docker-compose.yml` raíz, reemplazar la dependencia compartida de Auth y Colaboración sobre `pizarra-db` por sus contenedores propios (junto con `canvas-db` de Estefan y `notification-db` de Cristian):

```yaml
  # D1 · UserDB (exclusiva de authentication-backend en Go)
  user-db:
    image: postgres:16-alpine
    container_name: collaboard-user-db
    restart: unless-stopped
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: users
    ports:
      - "5435:5432"
    volumes:
      - user_pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres -d users"]
      interval: 3s
      timeout: 3s
      retries: 20
    networks:
      - collaboard-network

  # D2 · BoardDB (exclusiva de colaboracion-backend en Python)
  board-db:
    image: postgres:16-alpine
    container_name: collaboard-board-db
    restart: unless-stopped
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: boards
    ports:
      - "5433:5432"
    volumes:
      - board_pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres -d boards"]
      interval: 3s
      timeout: 3s
      retries: 20
    networks:
      - collaboard-network
```

### 1.2 Variables de entorno de `authentication-backend` y `colaboracion-backend`

- **`authentication-backend` (Go):**
  - `USER_DATABASE_URL: postgres://postgres:postgres@user-db:5432/users?sslmode=disable` (también sigue aceptando `AUTH_DATABASE_URL`).
  - `JWT_SECRET: ${JWT_SECRET:-clave-de-desarrollo-cambiala-en-produccion-32b}`
  - `FRONTEND_URL: http://localhost:8088`
  - `GET /auth/me` ya acepta tanto `Authorization: Bearer <JWT>` como la cookie `cb_session`.

- **`colaboracion-backend` (Python):**
  - `BOARD_DATABASE_URL: postgresql+psycopg://postgres:postgres@board-db:5432/boards`
  - `DATABASE_URL: postgresql+psycopg://postgres:postgres@board-db:5432/boards`
  - `JWT_SECRET: ${JWT_SECRET:-clave-de-desarrollo-cambiala-en-produccion-32b}`
  - `JWT_ISSUER: collaboard-auth`
  - `FRONTEND_URL: http://localhost:8088`
  - `ALLOWED_ORIGINS: http://localhost:8088,http://127.0.0.1:8088,http://localhost:5173`
  - `INTERNAL_SERVICE_TOKEN: ${INTERNAL_SERVICE_TOKEN:-token-de-servicio-solo-desarrollo}`
  - `NOTIFICATIONS_URL: http://notification-api:8085` (o `http://dev-mocks:4100` en el entorno de desarrollo)
  - `PIZARRA_INTERNAL_URL: http://pizarra-backend:8000`
  - `CHAT_INTERNAL_URL: http://chat-api:8090`

### 1.3 Reglas del API Gateway (Nginx)

- Bloquear cualquier ruta `/internal/*` desde el exterior (`location ~* (^|/)internal(/|$) { return 404; }`).
- Enrutar `/api/boards`, `/api/boards/*` y `/api/invites/*` hacia `colaboracion-backend:8000` (`/boards`, `/boards/*`, `/invites/*`), preservando `Authorization`, `Cookie`, `Origin` y `X-Request-Id`.

---

## 2. Para Estefan (Paquete D: Persistencia de Pizarra y migración)

1. **`colaboracion-module` ya implementa exactamente las dos rutas que consume `pizarra-backend/app/internal_client.py`:**
   - `GET /internal/boards/{board_id}/access`
   - `PATCH /internal/boards/{board_id}/metadata`
2. **Al borrar un tablero (`DELETE /boards/{id}`), Colaboración invoca automáticamente** tu endpoint `DELETE {PIZARRA_INTERNAL_URL}/internal/canvas/boards/{board_id}` con cabecera `X-Service-Token`.
3. **Ajustes recomendados en `pizarra-backend` para cerrar los criterios de aceptación compartidos:**
   - En `app/internal_client.py`, incluir la cabecera `"X-Service-Token": os.getenv("INTERNAL_SERVICE_TOKEN", "token-de-servicio-solo-desarrollo")` y reenviar el JWT del usuario en `Authorization: Bearer <token>` cuando esté disponible.
   - En `app/internal_client.py`, cuando Colaboración no responda o falle la red, **no** devolver `return True, "owner"` (el plan exige que una falla del servicio de permisos rechace nuevas operaciones con error recuperable).
   - Retirar de `pizarra-backend/app/main.py` el registro de los routers duplicados `boards.router` e `invites.router` (el CRUD de tableros e invitaciones ahora vive únicamente en `colaboracion-module`).
4. **Migración desde P1:**
   - Tu script `scripts/migrate_p1_to_canvasdb.py` migra `board_states` y `board_versions` a `canvas-db`.
   - Mi script `scripts/migrate_p1_to_userdb_boarddb.py` migra `auth.users` a `user-db` y `boards`, `board_members`, `board_invites` a `board-db`. Ambos leen de la base P1 sin modificarla.

---

## 3. Para Marlon (Paquete C: Tiempo real de Pizarra y Chat en Java)

1. **En `chat-module` (`CollaborationClient.java`):**
   - Cambiar la consulta de permisos al endpoint interno `GET /internal/boards/{boardId}/access` enviando `Authorization: Bearer <token>` y `X-Service-Token: <INTERNAL_SERVICE_TOKEN>`.
   - Cambiar la consulta de destinatarios para `chat.message.created` a `GET /internal/boards/{boardId}/recipients?exclude={senderId}` (devuelve `{"board_id","board_name","owner_id","recipient_ids":[...]}` ya sin el autor).
2. **Limpieza de mensajes al borrar un tablero:**
   - Exponer en `chat-module` el endpoint idempotente `DELETE /internal/chat/boards/{boardId}` (validando `X-Service-Token`) que borre los mensajes del tablero en la base `chat` de MongoDB y cierre los WebSockets activos de esa sala, devolviendo `204 No Content`. Colaboración ya lo llama y reintenta automáticamente desde su outbox.
3. **En `pizarra-backend/app/routers/ws.py`:**
   - Aceptar el JWT tanto desde `?token=` (reescrito por Nginx a partir de la cookie `cb_session`) como desde la cabecera `Authorization: Bearer` (cliente Electron) o cookie `cb_session`, y revalidar el rol contra `GET /internal/boards/{board_id}/access`.

---

## 4. Para Cristian (Paquete E: NotificationAPI y Worker en C#)

- `colaboracion-module` envía los eventos `invite.accepted` desde su outbox transaccional mediante:
  - `POST {NOTIFICATIONS_URL}/internal/events`
  - Cabeceras: `X-Service-Token: <INTERNAL_SERVICE_TOKEN>`, `X-Event-Id: <event_id>`, `Content-Type: application/json`.
  - Cuerpo:
    ```json
    {
      "event_id": "evt-invite-...",
      "type": "invite.accepted",
      "occurred_at": "2026-10-30T20:20:00Z",
      "actor_id": "<usuario que aceptó>",
      "board_id": "<id del tablero>",
      "recipient_ids": ["<owner_id del tablero>"],
      "payload": {
        "board_name": "Nombre del tablero",
        "actor_name": "Nombre de quien aceptó",
        "role": "editor"
      }
    }
    ```
- En caso de fallo o caída temporal de `NotificationAPI`, Colaboración reintenta con **exactamente el mismo `event_id`** hasta recibir `202 Accepted` (o `200`/`201`/`204`/`409`).
