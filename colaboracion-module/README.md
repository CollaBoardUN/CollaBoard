# CollaBoard — Módulo Lógico de Colaboración (Paquete B)

Autoridad única de **tableros, miembros, roles (`owner`, `editor`, `viewer`), invitaciones por enlace, autorización interna (`/internal/*`) y outbox transaccional** sobre **BoardDB** (`board-db` en PostgreSQL).

## Responsabilidades en el Prototipo 2

1. **Dominio exclusivo de tableros (`BoardDB`):**
   - Tablas propias: `boards`, `board_members`, `board_invites`, `outbox_events`.
   - Cero tablas de usuarios (`UserDB`) ni de lienzo/versiones (`CanvasDB`).
2. **Autorización interna por HTTP (`/internal/*`):**
   - `GET /internal/boards/{board_id}/access` — valida existencia, estado activo y rol del usuario (`owner`, `editor`, `viewer`).
   - `GET /internal/boards/{board_id}/recipients` — lista destinatarios autorizados de un tablero excluyendo al actor.
   - `PATCH /internal/boards/{board_id}/metadata` — recibe el callback de guardado de Pizarra sin permitir que un autosave tardío resucite tableros borrados.
3. **Sesión compatible con Web SSR y cliente local Electron:**
   - Acepta `Authorization: Bearer <JWT>` o cookie HttpOnly `cb_session`, validando `iss="collaboard-auth"` y verificando `Origin` en operaciones mutantes con cookie.
4. **Outbox transaccional y borrado coordinado:**
   - Al aceptar una invitación (`POST /invites/{token}/accept`), persiste en la misma transacción SQL el evento `invite.accepted` dirigido al propietario y lo despacha con reintentos hacia `POST {NOTIFICATIONS_URL}/internal/events` conservando el mismo `event_id`.
   - Al borrar un tablero (`DELETE /boards/{board_id}`), cambia `status="deleting"`, bloquea accesos e invitaciones de inmediato, y despacha `DELETE` idempotentes hacia Canvas y Chat antes de marcar `status="deleted"`.

## Ejecución local y pruebas

```bash
cd colaboracion-module
python -m pip install -r requirements-dev.txt
python -m pytest -q
python -m ruff check .
```

Con Docker Compose (levanta `board-db` en el puerto `5433` y `colaboracion-backend` en `8002`):

```bash
docker compose up --build -d
curl http://localhost:8002/health
```
