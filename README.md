# Pizarra colaborativa

Pizarra online donde varias personas dibujan juntas en tiempo real.

Este repositorio contiene el **módulo de tableros y colaboradores** (Persona 1), completo y probado. También deja preparados los puntos de conexión para el resto del equipo.

| Módulo | Responsable | Estado |
| --- | --- | --- |
| **Autenticación (registro, login, JWT)** | **Servicio Go** | **Integrado en `auth/login`** |
| **Tableros y colaboradores** | **Persona 1** | **Listo** |
| Herramientas de dibujo (canvas) | Persona 2 | Pendiente. Ver [integración](docs/INTEGRACION.md#persona-2-canvas) |
| Tiempo real (WebSocket) | Persona 3 | **Listo** |
| Persistencia, historial, exportación | Persona 4 | Pendiente. Ver [integración](docs/INTEGRACION.md#persona-4-persistencia) |

## Qué hace el módulo de tableros

- Crear, listar, renombrar y borrar tableros.
- Roles por tablero: **dueño** (`owner`), **editor** (`editor`) y **solo ver** (`viewer`).
- Compartir por link con un rol y una fecha de vencimiento. Se pueden ver los links activos y desactivarlos.
- Unirse por link. Si ya eras viewer y abres un link de editor, subes de permiso; nunca bajas por abrir un link.
- Gestión de miembros: cambiar el rol, quitar a alguien o salirse del tablero.
- `require_role(...)`: la verificación de permisos que reutilizan los demás módulos.

**Entregable cumplido**: un usuario autenticado crea un tablero, lo comparte, y otro entra con el rol correcto. Lo verifica el test de punta a punta en un navegador real (`e2e/`).

## Stack

| | |
| --- | --- |
| Backend | Python 3.12, FastAPI, SQLAlchemy 2, Alembic, PostgreSQL 16, PyJWT |
| Frontend | React 19, TypeScript, Vite, React Router, Zustand |
| Autenticación | Go 1.23, Chi, PostgreSQL, Argon2id, JWT |
| Calidad | pytest, Vitest + Testing Library, Playwright, Ruff, ESLint, GitHub Actions |

## Cómo correrlo

### Opción A: Docker (lo más fácil)

```bash
docker compose up --build
```

- Frontend: http://localhost:5173
- API y documentación interactiva: http://localhost:8000/docs
- API de autenticación Go: http://localhost:8001/health

Registra una cuenta con nombre, correo y contraseña. Para probar cómo se comparte, abre una ventana privada y registra otra cuenta.

### Opción B: sin Docker

Necesitas Python 3.11 o superior, Node 20 o superior, y PostgreSQL.

```bash
# 1. Base de datos
createdb pizarra

# 2. Backend
cd backend
python -m venv .venv && source .venv/bin/activate   # En Windows: .venv\Scripts\activate
pip install -r requirements-dev.txt
cp .env.example .env            # revisa DATABASE_URL
alembic upgrade head            # crea las tablas
uvicorn app.main:app --reload   # http://localhost:8000/docs

# 3. Frontend (en otra terminal)
cd frontend
npm install
cp .env.example .env
npm run dev                     # http://localhost:5173
```

## Tests

```bash
cd backend && pytest                    # 50 tests de la API (usa SQLite; no necesita PostgreSQL)
cd frontend && npm test                 # 25 tests de la interfaz
pip install -r e2e/requirements.txt && playwright install chromium
pytest e2e                              # flujo completo en un navegador (con backend y frontend corriendo)
```

La CI de GitHub corre todo en cada push: lint, tests del backend contra SQLite **y** PostgreSQL, migraciones (suben, coinciden con los modelos y bajan), tests del frontend, build, el flujo de punta a punta en Chromium y `docker compose`.

## Estructura

```
backend/
  app/
    auth.py          ← adaptador de auth: lee el JWT (punto de contacto con el login)
    permissions.py   ← require_role / get_role: lo reutilizan Personas 2, 3 y 4
    models.py        ← tablas boards, board_members, board_invites
    schemas.py       ← qué JSON entra y sale
    routers/         ← endpoints (boards, invites, dev_auth)
  migrations/        ← Alembic
  tests/
frontend/
  src/
    auth/            ← sesión (Zustand) y rutas protegidas
    lib/             ← cliente HTTP, funciones de la API, tipos
    stores/          ← estado de "mis tableros"
    components/      ← tarjetas, diálogo de compartir, modales
    pages/           ← dashboard, tablero, unirse por link, login de desarrollo
e2e/                 ← prueba de punta a punta con Playwright
docs/
  API.md             ← contrato de la API
  INTEGRACION.md     ← cómo se conectan los demás módulos
```

## Documentación

- [Contrato de la API](docs/API.md)
- [Guía de integración para el equipo](docs/INTEGRACION.md)
- [Módulo de autenticación Go](docs/AUTENTICACION.md)
- [Cómo contribuir](CONTRIBUTING.md)
