# Módulo Pizarra - CollaBoard

Este módulo encapsula la experiencia completa de la pizarra colaborativa en línea de CollaBoard:
- **`pizarra-frontend`**: SPA en React 19 + TypeScript + Vite con el lienzo interactivo, herramientas de dibujo, cursores en tiempo real, gestión de estados con Zustand y presentación de tableros.
- **`pizarra-backend`**: Microservicio FastAPI en Python 3.12 con sincronización en tiempo real vía WebSockets (`/ws/boards/{board_id}`), validación de trazos/elementos, presencia de usuarios y persistencia con PostgreSQL y SQLAlchemy.

---

## Estructura del Módulo

```
pizarra-module/
├── docker-compose.yml
├── README.md
├── pizarra-frontend/
│   ├── Dockerfile
│   ├── nginx.conf
│   ├── package.json
│   ├── tsconfig.json
│   ├── vite.config.ts
│   ├── index.html
│   └── src/
│       ├── App.tsx
│       ├── main.tsx
│       ├── presentation/   (Lienzo de dibujo, herramientas visuales)
│       ├── realtime/       (Conector WebSocket de la pizarra, presencia)
│       ├── domain/         (Entidades y reglas del lienzo)
│       ├── components/     (Componentes reutilizables)
│       └── pages/          (BoardPage, DashboardPage, etc.)
└── pizarra-backend/
    ├── Dockerfile
    ├── requirements.txt
    ├── alembic.ini
    ├── migrations/
    ├── tests/
    └── app/
        ├── main.py         (FastAPI + WebSockets de la pizarra)
        ├── realtime/       (Salas de tableros, broadcast y validación de trazos)
        ├── models.py       (Tablas de tableros, miembros, invitaciones)
        ├── permissions.py  (Control de acceso require_role)
        └── routers/        (ws.py, boards.py, invites.py, dev_auth.py)
```

---

## Cómo Ejecutar el Módulo

### Con Docker Compose (Recomendado)
Desde esta carpeta (`pizarra-module/`):

```bash
docker compose up --build
```

- **Frontend:** http://localhost:5173
- **Backend API & Swagger:** http://localhost:8000/docs
- **PostgreSQL:** localhost:5432
