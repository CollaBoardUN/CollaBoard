# Contrato de la API: tableros y colaboradores

URL base en local: `http://localhost:8000`. La documentación interactiva, donde puedes probar cada endpoint, está en `/docs`.

Todas las rutas exigen el header `Authorization: Bearer <JWT>`.

## Roles

| Rol | Puede |
| --- | --- |
| `viewer` | Ver el tablero y la lista de miembros |
| `editor` | Lo anterior, y dibujar (lo verifica el módulo de canvas con `require_role(Role.editor)`) |
| `owner` | Todo: renombrar, borrar, crear y desactivar links, cambiar roles, quitar miembros |

Cada tablero tiene exactamente un `owner`: quien lo creó. Por link solo se puede dar `editor` o `viewer`.

## Errores

| Código | Cuándo |
| --- | --- |
| 401 | Falta el token, es inválido o expiró |
| 403 | Eres miembro, pero tu rol no alcanza |
| 404 | El tablero no existe **o no eres miembro**. No se revela si existe un tablero ajeno |
| 422 | El cuerpo no es válido (por ejemplo, un nombre vacío o un rol `owner` en una invitación) |

Formato: `{"detail": "mensaje legible en español"}`.

## Tableros

### `POST /boards`: crear

```json
{ "name": "Retro de octubre" }
```

Responde `201` con un **Board**. Quien lo crea queda como `owner`.

```json
{
  "id": "6f1c…",
  "name": "Retro de octubre",
  "owner_id": "ana",
  "my_role": "owner",
  "member_count": 1,
  "created_at": "2026-10-11T14:00:00Z",
  "updated_at": "2026-10-11T14:00:00Z"
}
```

### `GET /boards`: mis tableros

Lista de **Board** donde soy miembro, ordenada por la última edición.

### `GET /boards/{board_id}`: detalle *(viewer o superior)*

Responde un **Board**. `my_role` indica qué puede hacer el usuario actual.

### `PATCH /boards/{board_id}`: renombrar *(owner)*

```json
{ "name": "Nuevo nombre" }
```

### `DELETE /boards/{board_id}`: borrar *(owner)*

Responde `204`. Borra también los miembros y las invitaciones.

## Miembros

### `GET /boards/{board_id}/members` *(viewer o superior)*

```json
[
  { "user_id": "ana", "display_name": "Ana", "role": "owner", "joined_at": "…" },
  { "user_id": "beto", "display_name": "Beto", "role": "editor", "joined_at": "…" }
]
```

### `PATCH /boards/{board_id}/members/{user_id}`: cambiar rol *(owner)*

```json
{ "role": "viewer" }
```

El rol del `owner` no se puede cambiar.

### `DELETE /boards/{board_id}/members/{user_id}`: quitar o salirse

- El `owner` puede quitar a cualquier miembro.
- Cualquier miembro puede quitarse a sí mismo, es decir, salirse.
- El `owner` no puede salirse; puede borrar el tablero.

## Invitaciones (compartir por link)

### `POST /boards/{board_id}/invite`: crear link *(owner)*

```json
{ "role": "editor", "expires_in_hours": 168 }
```

`expires_in_hours` va de 1 a 720, o `null` para que no venza. Por defecto son 168 (7 días). Responde `201`:

```json
{
  "id": "…",
  "token": "x9Fq…",
  "url": "http://localhost:5173/join/x9Fq…",
  "role": "editor",
  "created_at": "…",
  "expires_at": "…",
  "uses": 0
}
```

### `GET /boards/{board_id}/invites`: links activos *(owner)*

Lista de invitaciones que no han vencido ni se han desactivado.

### `DELETE /boards/{board_id}/invites/{invite_id}`: desactivar *(owner)*

### `GET /invites/{token}`: vista previa *(cualquier usuario con sesión)*

```json
{
  "board_id": "…",
  "board_name": "Retro de octubre",
  "role": "editor",
  "already_member": false,
  "current_role": null
}
```

Responde `404` si el link no existe, venció o se desactivó.

### `POST /invites/{token}/accept`: unirme

```json
{ "board_id": "…", "role": "editor" }
```

- Si no era miembro, queda con el rol del link.
- Si ya era miembro con un rol menor, sube al rol del link.
- Si ya tenía un rol igual o mayor, lo conserva. Abrir un link nunca baja el rol de nadie.

## Solo en desarrollo

### `POST /dev/token`

Solo existe si `AUTH_DEV_MODE=true`. Emite un JWT para probar sin el módulo de login.

```json
{ "user_id": "ana", "name": "Ana" }
```

## Persistencia e historial de versiones

Detalle, mensajes del WebSocket y ajustes en [PERSISTENCIA.md](PERSISTENCIA.md).

| Método y ruta | Rol | Qué hace |
| --- | --- | --- |
| `GET /boards/{board_id}/state` | viewer | Estado actual y fecha del último guardado |
| `GET /boards/{board_id}/versions` | viewer | Historial sin los elementos |
| `GET /boards/{board_id}/versions/{version_id}` | viewer | Una versión con sus elementos |
| `POST /boards/{board_id}/versions` | editor | Guarda una versión manual (`{"name": "..."}` opcional). `409` si llegó al máximo |
| `PATCH /boards/{board_id}/versions/{version_id}` | editor | Renombra una versión |
| `POST /boards/{board_id}/versions/{version_id}/restore` | editor | Restaura una versión (guarda antes una copia del estado actual) |
| `DELETE /boards/{board_id}/versions/{version_id}` | owner | Borra una versión |
