# Guía de integración para el equipo

Este módulo es la puerta de entrada: decide quién puede ver o editar cada tablero. Aquí está lo que cada persona necesita para conectarse.

## Autenticación

> Auth real se implementa en [`authentication-module/`](../authentication-module/) (Go, :8001), con UI en `pizarra-module/pizarra-frontend/`. Se conservan `sub`, `name`, `email` y JWT HS256. Véase [AUTENTICACION.md](AUTENTICACION.md). En Docker, `AUTH_DEV_MODE=false`; no se usa `/dev/token`.


El módulo de auth emite el JWT; este módulo solo lo **lee**. Hay que acordar tres cosas:

1. **La misma clave y algoritmo.** Ambos módulos usan `JWT_SECRET` y `JWT_ALGORITHM` del `.env`.
2. **El id del usuario va en el campo `sub`** del token, como texto.
3. **Opcional:** si el token trae `name` o `email`, se usa para mostrar el nombre en la lista de miembros.

Payload esperado:

```json
{ "sub": "123", "name": "Ana Gómez", "email": "ana@unal.edu.co", "exp": 1760000000 }
```

**Backend.** Si auth prefiere usar su propia función, se reemplaza `get_current_user` en `backend/app/auth.py`. Lo único que necesita el resto del código es un objeto con `.id` y `.display_name`.

**Frontend.** Al iniciar sesión, la página de login real solo tiene que hacer esto:

```ts
import { useAuth } from "../auth/authStore";

useAuth.getState().setSession(token);
navigate(next); // `next` viene en la URL: /login?next=/join/abc
```

Cuando el login real esté listo:

1. Reemplazar `frontend/src/pages/LoginPage.tsx` por el de auth, o hacer que la ruta `/login` apunte a su página.
2. Poner `AUTH_DEV_MODE=false` en el backend y `VITE_DEV_LOGIN=false` en el frontend. El endpoint `/dev/token` desaparece.

> Los usuarios viven en la base de datos de auth. Aquí solo se guarda `user_id` como texto, sin llave foránea, para que los módulos no dependan entre sí.

## Persona 2: canvas

### Backend

Proteger los endpoints de elementos con `require_role`:

```python
from fastapi import APIRouter, Depends
from app.models import Role
from app.permissions import BoardAccess, require_role

router = APIRouter(prefix="/boards/{board_id}/elements", tags=["Elementos"])

@router.get("")
def list_elements(access: BoardAccess = Depends(require_role(Role.viewer))):
    # access.board, access.role, access.user.id
    ...

@router.post("")
def create_element(data: ElementIn, access: BoardAccess = Depends(require_role(Role.editor))):
    # Ya está garantizado que el usuario es editor u owner.
    # Usa access.user.id como "autor" del elemento.
    ...
```

La ruta debe tener `{board_id}`: `require_role` lo lee de ahí. Registra el router en `app/main.py`.

Para la tabla de elementos, usa `ForeignKey("boards.id", ondelete="CASCADE")`. Así, al borrar el tablero se borran sus elementos. Luego crea la migración:

```bash
cd backend
alembic revision --autogenerate -m "elementos del canvas"
alembic upgrade head
```

### Frontend

En `frontend/src/pages/BoardPage.tsx` reemplaza `BoardCanvasSlot` por tu componente de Konva. Recibe:

```ts
interface BoardCanvasProps {
  board: Board;     // id, name, my_role…
  canEdit: boolean; // false si es viewer: desactiva las herramientas
}
```

Para llamar a la API usa el cliente compartido, que ya agrega el token y maneja los errores:

```ts
import { api } from "../lib/api";
const elements = await api.get<Element[]>(`/boards/${board.id}/elements`);
```

## Persona 3: tiempo real

El WebSocket no usa dependencias HTTP, así que se verifica a mano con `decode_token` y `get_role`:

```python
from fastapi import WebSocket, WebSocketDisconnect, HTTPException
from app.auth import decode_token
from app.database import SessionLocal
from app.models import Role
from app.permissions import can, get_role

@app.websocket("/ws/boards/{board_id}")
async def board_ws(websocket: WebSocket, board_id: str, token: str):
    # El navegador no puede mandar headers en un WebSocket:
    # el token va en la URL  ->  /ws/boards/123?token=eyJ...
    try:
        user = decode_token(token)
    except HTTPException:
        await websocket.close(code=4401)
        return

    with SessionLocal() as db:
        role = get_role(db, board_id, user.id)
    if role is None:
        await websocket.close(code=4403)  # no es miembro
        return

    await websocket.accept()
    can_draw = can(role, Role.editor)
    # Si can_draw es False, ignora los eventos de crear, mover o borrar de este usuario.
```

**Recomendación:** si un owner quita a alguien o le baja el rol mientras está conectado, vuelve a consultar `get_role` antes de aplicar cada evento de dibujo, o cada pocos segundos.

En el frontend, el token está en `useAuth.getState().token` y la URL del backend en `API_URL` (`src/lib/api.ts`). Para pasar de `http` a `ws`, cambia el esquema: `API_URL.replace(/^http/, "ws")`.

## Persona 4: persistencia

- **Snapshots e historial:** protege la lectura con `require_role(Role.viewer)` y restaurar una versión con `require_role(Role.editor)` o `Role.owner`, según lo que decida el equipo.
- **Fecha de última edición:** al guardar, actualiza `board.updated_at`. El dashboard ordena por ese campo y muestra "editado hace…".
- **Miniatura:** `BoardCard` ya acepta la prop `thumbnailUrl`. Si se envía, muestra la imagen real en lugar del garabato. Basta con agregar el campo a `BoardOut` en `schemas.py` y pasarlo en `DashboardPage`.
- **Exportar PNG/PDF:** se hace en el frontend con el `stage` de Konva. No necesita permisos extra, porque cualquier miembro puede exportar lo que ve.

## Convenciones compartidas

- Ids de tablero: UUID como texto (`String(36)`).
- Ids de usuario: texto (`String(64)`), el `sub` del JWT.
- Fechas: UTC con zona horaria (`DateTime(timezone=True)`).
- Mensajes de error al usuario en español, en `detail`.
- Cada cambio de modelo lleva su migración de Alembic.
