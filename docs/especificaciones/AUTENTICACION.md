# CollaBoard — Autenticación integrada con `Merger`

## Arquitectura implementada

Este módulo conserva **Go + Chi** como API de autenticación en el puerto **8001**.
Su interfaz es un conjunto de componentes React dentro de la SPA de Pizarra en **5173**, no un contenedor separado.

| Componente | Carpeta | Puerto del host | Descripción |
|---|---|---:|---|
| Auth Go | `authentication-module/` | 8001 | Registro, login, usuario actual, JWT HS256 y hashes Argon2id |
| Pizarra UI | `pizarra-module/pizarra-frontend/` | 5173 | Login y registro con logo oficial, pizarra, invitaciones |
| Pizarra API | `pizarra-module/pizarra-backend/` | 8000 | Validación JWT y WebSockets de pizarra |
| Colaboración | `colaboracion-module/` | 8002 | Tableros, miembros e invitaciones; comparte contrato JWT |
| Pixels frontend | `pixels-module/pixel-frontend/` | 3000 | Lienzo colectivo Pixels |
| Pixels backend | `pixels-module/pixel-backend/` | 8080 | API y WebSocket Pixels |
| PostgreSQL | `pizarra-db` | 5432 | Esquema `auth` para cuentas y `public` para tableros |
| MongoDB | `pixels-nosql-db` | 27017 | Persistencia de Pixels |

## Integración JWT y base de datos

- Go genera JWT **HS256** de **1 hora** con `sub` (UUID en string), `name`, `email`, `iat`, `iss` y `exp`.
- FastAPI Pizarra y Colaboración siguen validando JWT de forma local mediante el **mismo `JWT_SECRET`**.
- La UI de Pizarra llama a Go mediante `VITE_AUTH_URL=http://localhost:8001`, guarda el token mediante `useAuth.setSession` y mantiene la redirección segura `next` después del login.
- Las invitaciones `GET /invites/{token}` y el canal `ws://localhost:8000/ws/boards/{id}?token=...` siguen en Pizarra. No se modifica la API de Pixels.
- Go migra su tabla `auth.users` y mantiene las contraseñas como hashes Argon2id. No se guarda la confirmación. PostgreSQL lo comparte físicamente pero separa los esquemas.
- Pizarra y Colaboración comparten la misma revisión Alembic `0001`. Para evitar migración simultánea, el Docker Compose global arranca el servicio de Colaboración **después** de que Pizarra pase su healthcheck. Es una medida de compatibilidad del prototipo; el equipo debe decidir después qué servicio será el propietario definitivo de las tablas públicas y sus migraciones.

## Endpoints de Auth

| Método | Ruta | Respuesta |
|---|---|---|
| `GET` | `/health` | `{"status":"ok"}` |
| `POST` | `/auth/register` | `201` con `{access_token, token_type, user}` |
| `POST` | `/auth/login` | `200` con `{access_token, token_type, user}` |
| `GET` | `/auth/me` | `200` datos de usuario si Bearer JWT válido |

`POST /auth/register` recibe `name`, `email`, `password` y `confirm_password`.
La base de datos no prueba que el correo pertenezca a su dueño: la **verificación de correo**, recuperación y OAuth quedan fuera del alcance de este prototipo.

## Despliegue integrado (Ubuntu)

Desde la **raíz** del repositorio, estando en la rama de integración:

```bash
# Crear o conservar JWT_SECRET local (NO versionarlo)
[ -f .env ] || python3 -c 'import secrets; print("JWT_SECRET=" + secrets.token_urlsafe(48))' > .env

docker compose config --quiet
docker compose up --build -d
docker compose ps

curl -fsS http://localhost:8001/health
curl -fsS http://localhost:8000/health
curl -fsS http://localhost:8002/health
curl -fsS http://localhost:8080/api/health
```

UI: <http://localhost:5173/register>, <http://localhost:5173/login> y Pixels <http://localhost:3000>.

> Si antes levantaste `auth/login` en el mismo equipo, ejecuta `docker compose down` **en esa rama anterior** antes de cambiar a la de integración. **No uses `down -v`**, porque borraría los volúmenes de PostgreSQL y MongoDB.

### Comprobar tabla y datos

```bash
docker compose exec pizarra-db psql -U postgres -d pizarra -c 'SELECT id, name, email FROM auth.users;'
```

### Flujo de prueba manual

1. Registrar usuario A en `localhost:5173/register` y crear una pizarra.
2. Generar un enlace de invitación y abrirlo en ventana privada.
3. Registrar usuario B: debe regresar a la invitación, poder unirse y ver la pizarra.
4. Comprobar sincronización en dos navegadores y permisos `viewer`/`editor`.
5. Abrir `localhost:3000`, dibujar un píxel y verificar que MongoDB responde.
6. Verificar que login incorrecto y registro de correo duplicado presenten errores.

### Pruebas automatizadas

```bash
cd authentication-module && go mod tidy && go test ./... && cd ..
cd pizarra-module/pizarra-frontend && npm ci && npm test && npm run build && cd ../..
# Playwright: requiere servicios corriendo y dependencias de e2e instaladas:
python3 -m pip install -r e2e/requirements.txt
python3 -m playwright install chromium
python3 -m pytest e2e -v
```

`go mod tidy` genera `authentication-module/go.sum`: agrégalo al commit junto con el código.

## Límites del prototipo

- Se mantienen JWT en `localStorage` por compatibilidad, y los WebSockets de Pizarra transmiten el token por la URL. Usar HTTPS/WSS y revisar CSP, logging y almacenamiento de tokens antes de producción.
- El logout del frontend elimina la sesión del navegador, pero no revoca tokens ya emitidos, que vencen a la hora.
- El limitador de logins funciona en memoria y no coordina múltiples réplicas.
- La UI Pixels es un módulo separado: puede no compartir la sesión de Pizarra sin una integración adicional de identidad. El paquete **no inventa** una autenticación para Pixels donde el código actual no la utiliza.
- No se incorporan persistencia de trazos ni otras funcionalidades que no estén implementadas en `Merger`.
