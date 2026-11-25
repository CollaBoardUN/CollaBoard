# Contratos que consumen las presentaciones (web SSR y cliente local)

Propuesta del paquete A sobre la sección 4 del plan P2. Son las rutas **públicas del gateway**
que usan la web y Electron. Los mocks de [`web-ssr/dev/mocks`](../../web-ssr/dev/mocks/) las
implementan y sus pruebas (`npm test`) sirven de especificación ejecutable: si el servicio
real pasa esas mismas pruebas, la interfaz funciona sin cambios.

**Reglas comunes**

- Autenticación de usuario: `Authorization: Bearer <JWT de Auth>` en HTTP. En WebSocket desde
  el navegador llega la cookie `cb_session` (mismo JWT); desde Electron, `Authorization` en el
  *handshake*. Nunca el token en la URL.
- Identidad: el autor o destinatario sale **siempre del token**, nunca del cuerpo.
- Errores: JSON `{"detail": "mensaje legible en español"}`. La interfaz muestra `detail` tal cual.
- Fechas: ISO 8601 en UTC (`2026-10-25T15:04:00Z`).
- Correlación: respetar y devolver `X-Request-Id`.
- Rutas `/internal/*`: solo entre servicios; el gateway no las publica.

## 1. Rutas públicas del gateway usadas por la interfaz

| Ruta pública | Servicio | Uso en la interfaz |
|---|---|---|
| `POST /api/auth/login`, `POST /api/auth/register`, `GET /api/auth/me` | Auth (Go) | Server Actions de la web y verificación de sesión en el SSR |
| `/api/boards`, `/api/boards/{id}`, `/members`, `/invite(s)` | Colaboración (Python) | Dashboard, compartir, roles |
| `/api/invites/{token}`, `/api/invites/{token}/accept` | Colaboración | Unirse por link |
| `GET /api/canvas/boards/{id}/state` | Pizarra (Python) → `/boards/{id}/state` | Estado guardado en el SSR del tablero |
| `WS /ws/boards/{id}` | Pizarra | Dibujo en tiempo real (protocolo del P1 sin cambios + `saved`/`restored`) |
| `GET/POST /api/chat/boards/{id}/messages` | Chat (Java) | Historial y envío |
| `WS /ws/chat/boards/{id}` | Chat | Mensajes en vivo |
| `GET /api/notifications`, `PATCH /api/notifications/{id}/read` | NotificationAPI (C#) | Bandeja |

## 2. Chat API (Java)

### Mensaje

```json
{
  "id": "5d904790-d4e8-4be6-80ab-2dda7ce4466d",
  "board_id": "31b6cc68-118d-4195-8490-940203f8e18d",
  "sender_id": "1360536d-f69b-41f4-94fd-c8e25b971365",
  "sender_name": "Beto Ruiz",
  "text": "¡Hola! Ya me uní al tablero",
  "client_message_id": "8c0e1f9a-6b6a-4f6e-9a77-2f3b1f0d2c11",
  "created_at": "2026-10-25T23:11:24.814Z"
}
```

### `GET /api/chat/boards/{id}/messages`

| Parámetro | Descripción |
|---|---|
| `limit` | 1–100 (por defecto 30) |
| `before` | Cursor opaco devuelto en `next_cursor`: mensajes **anteriores** |
| `after` | Id de mensaje: mensajes **posteriores** (recuperación tras reconectar o en sondeo) |

Respuesta `200`: `{"items": [Mensaje...], "next_cursor": "..." | null}` con `items` en orden
**cronológico** (antiguo → reciente). Sin `before`/`after` devuelve la página más reciente.
`404` si el tablero no existe o la persona no es miembro (no se revela cuál de las dos).

### `POST /api/chat/boards/{id}/messages`

Cuerpo: `{"text": "...", "client_message_id": "<uuid del cliente>"}`.

- `text`: se recorta; 1–2000 caracteres, si no `422`.
- `client_message_id`: 8–64 caracteres `[A-Za-z0-9-]`, si no `422`.
- Idempotencia por `(board_id, sender_id, client_message_id)`: primera vez `201` con el
  mensaje; reenvío `200` con **el mismo** mensaje (mismo `id`). La interfaz reintenta con el
  mismo id cuando falla la red, así nunca se duplica.
- Tras guardar: difundir por WebSocket y emitir `chat.message.created` (ver §4).

### `WS /ws/chat/boards/{id}`

- Servidor → cliente: `{"type":"message","message":Mensaje}`, `{"type":"pong"}`,
  `{"type":"error","code":"...","message":"..."}`.
- Cliente → servidor: solo `{"type":"ping"}` (cada 25 s). **No se escribe por el socket**: un
  único canal de escritura HTTP.
- Cierre `4401` sin sesión válida, `4403` sin acceso (la interfaz deja de reintentar). Revalidar
  el acceso periódicamente: quien sale del tablero deja de recibir mensajes.
- La interfaz, al (re)conectar, pide `?after=<último id>`; si el socket se cae, sondea cada 4 s
  hasta reconectar.

## 3. NotificationAPI (C#)

### Notificación

```json
{
  "id": "0b3c6a52-0f2e-4c55-9d3e-7d1f6f1f2a10",
  "type": "chat.message.created",
  "board_id": "31b6cc68-118d-4195-8490-940203f8e18d",
  "actor_id": "1360536d-f69b-41f4-94fd-c8e25b971365",
  "payload": { "board_name": "Arquitectura P2", "actor_name": "Beto Ruiz", "preview": "¡Hola!" },
  "created_at": "2026-10-25T23:11:25Z",
  "read_at": null
}
```

La interfaz arma el texto a partir de `type` y `payload` (`board_name`, `actor_name`, `role`,
`preview`) y tolera tipos nuevos.

| Ruta | Respuesta |
|---|---|
| `GET /api/notifications?limit=20` | `200 {"items":[...], "unread_count": N}` del usuario del token, más recientes primero |
| `PATCH /api/notifications/{id}/read` | `200` con la notificación marcada. `404` si no existe **o es de otra cuenta** |

## 4. Eventos internos (Colaboración / Chat → NotificationAPI)

`POST /internal/events` con identidad de servicio (el mock usa `X-Service-Token`) → `202`.

```json
{
  "event_id": "evt-...",
  "type": "invite.accepted",
  "occurred_at": "2026-10-25T23:20:00Z",
  "actor_id": "<quien aceptó>",
  "board_id": "<tablero>",
  "recipient_ids": ["<dueño del tablero>"],
  "payload": { "board_name": "Arquitectura P2", "actor_name": "Beto Ruiz", "role": "editor" }
}
```

- Tipos mínimos: `invite.accepted` y `chat.message.created`. Otro tipo → `422`.
- Nunca se notifica al autor (`actor_id`) aunque venga en `recipient_ids`.
- Idempotente por `(event_id, recipient_id)`: repetir el evento no crea otra notificación.
- La interfaz distingue la operación (p. ej. "mensaje enviado") de la notificación, que es
  asíncrona y puede tardar.
