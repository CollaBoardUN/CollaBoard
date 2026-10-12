# Módulo Lógico de Colaboración - CollaBoard

Este módulo encapsula la **lógica de negocio de tableros y colaboradores** (Persona 1) de la plataforma CollaBoard. Es un microservicio de backend desacoplado que define y aplica las reglas de gobernanza, acceso y compartición de tableros.

---

## Responsabilidades del Módulo

1. **Gestión de Tableros (CRUD):**
   - Crear, listar, renombrar y eliminar tableros.
2. **Control de Acceso y Roles:**
   - Roles soportados: **dueño** (`owner`), **editor** (`editor`) y **solo ver** (`viewer`).
   - Función centralizada `require_role(role)` para proteger recursos.
3. **Membresías de Colaboradores:**
   - Asignar o cambiar roles de miembros.
   - Quitar miembros o permitir que un colaborador abandone el tablero.
4. **Enlaces de Invitación:**
   - Generación de links de invitación únicos con rol preasignado y fecha de caducidad.
   - Endpoint seguro para unirse a un tablero mediante link (`POST /join/{token}`).
   - Subida automática de permisos si un usuario `viewer` abre un link de `editor`.

---

## Estructura del Módulo

```
colaboracion-module/
├── Dockerfile
├── docker-compose.yml
├── README.md
├── requirements.txt
├── requirements-dev.txt
├── alembic.ini
├── pyproject.toml
├── migrations/             (Migraciones de tablas boards, board_members, board_invites)
├── tests/                  (Pruebas unitarias y de integración)
└── app/
    ├── main.py             (FastAPI con endpoints de tableros e invitaciones)
    ├── auth.py             (Adaptador de lectura de JWT)
    ├── permissions.py      (require_role, get_role, can)
    ├── models.py           (Modelos SQLAlchemy: Board, BoardMember, BoardInvite, Role)
    ├── schemas.py          (Esquemas Pydantic para requests y responses)
    ├── database.py         (Conexión a PostgreSQL y sesiones)
    ├── config.py           (Configuración y variables de entorno)
    └── routers/
        ├── boards.py       (Endpoints CRUD y miembros)
        ├── invites.py      (Endpoints de enlaces y unión)
        └── dev_auth.py     (Login de desarrollo)
```

---

## Cómo Ejecutar el Módulo

### Con Docker Compose
Desde esta carpeta (`colaboracion-module/`):

```bash
docker compose up --build
```

- **Documentación Swagger:** http://localhost:8000/docs
- **Health Check:** http://localhost:8000/health
- **PostgreSQL:** localhost:5432
