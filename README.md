<p align="center">
  <img src="docs/collaboard-logo.png" alt="CollaBoard Logo" width="130" />
</p>

# CollaBoard — Pizarra Colaborativa y Suite de Creación

Plataforma colaborativa modular en tiempo real donde varias personas crean, dibujan y colaboran juntas.

---

## 📁 Arquitectura Modular del Repositorio

El proyecto está organizado en **módulos independientes y desacoplados**, cada uno con su propio contenedor y ciclo de desarrollo:

```
CollaBoard/
├── colaboracion-module/     # Módulo Lógico de Colaboración (Persona 1)
│   ├── Dockerfile
│   ├── docker-compose.yml
│   ├── README.md
│   ├── app/                # Lógica de tableros, roles, permisos e invitaciones
│   ├── migrations/         # Migraciones Alembic (PostgreSQL)
│   └── tests/
│
├── pizarra-module/         # Módulo de Pizarra Colaborativa en Tiempo Real
│   ├── docker-compose.yml
│   ├── README.md
│   ├── pizarra-frontend/   # React 19 + Vite + Canvas + Presencia en vivo
│   └── pizarra-backend/    # FastAPI + WebSockets sincronización de trazos
│
├── pixels-module/          # Módulo Wplace Pixels (Lienzo colectivo de arte)
│   ├── docker-compose.yml
│   ├── README.md
│   ├── EXPLICACION_MODULO.md
│   ├── pixel-frontend/     # SPA React 18 + HTML5 Canvas con doble buffer
│   └── pixel-backend/      # FastAPI + Motor asíncrono + MongoDB NoSQL
│
├── docs/                   # Documentación de integración y protocolos
└── e2e/                    # Pruebas de punta a punta con Playwright
```

---

## 🚀 Resumen de los Módulos

| Módulo | Tipo | Tecnologías Clave | Puerto / URL |
|---|---|---|---|
| **`pizarra-module`** | Frontend + Backend | React 19, FastAPI, PostgreSQL, WebSockets | Web: `http://localhost:5173`<br>API: `http://localhost:8000/docs` |
| **`colaboracion-module`** | Lógica de Negocio (Backend) | FastAPI, SQLAlchemy, PostgreSQL, Alembic | API: `http://localhost:8000/docs` |
| **`pixels-module`** | Frontend + Backend | React 18, FastAPI, MongoDB (NoSQL), WebSockets | Web: `http://localhost:3000`<br>API: `http://localhost:8000/docs` |

---

## 🛠️ Cómo Ejecutar Cada Módulo

### 1. Módulo de Pizarra (`pizarra-module`)
```bash
cd pizarra-module
docker compose up --build
```
- **Lienzo de Pizarra:** [http://localhost:5173](http://localhost:5173)
- **API y Swagger:** [http://localhost:8000/docs](http://localhost:8000/docs)

### 2. Módulo de Colaboración (`colaboracion-module`)
```bash
cd colaboracion-module
docker compose up --build
```
- **API de Colaboración:** [http://localhost:8000/docs](http://localhost:8000/docs)
- **Health Check:** [http://localhost:8000/health](http://localhost:8000/health)

### 3. Módulo de Pixels Wplace (`pixels-module`)
```bash
cd pixels-module
docker compose up --build
```
- **Lienzo Pixels Wplace:** [http://localhost:3000](http://localhost:3000)
- **API Pixels:** [http://localhost:8000/docs](http://localhost:8000/docs)
- **Guía Completa:** Ver [EXPLICACION_MODULO.md](pixels-module/EXPLICACION_MODULO.md)

---

## 🧪 Pruebas Automatizadas

- **Pruebas de Colaboración:**
  ```bash
  cd colaboracion-module && pytest
  ```
- **Pruebas de Pizarra:**
  ```bash
  cd pizarra-module/pizarra-backend && pytest
  cd pizarra-module/pizarra-frontend && npm test
  ```
- **Pruebas E2E:**
  ```bash
  pytest e2e
  ```

---

## 🔐 Autenticación Go (`authentication-module`)

- **API:** `http://localhost:8001/health` · Registro: `POST /auth/register` · Login: `POST /auth/login`.
- **Frontend:** formularios en la aplicación de Pizarra `http://localhost:5173/login` y `/register`.
- **Credenciales:** hash Argon2id; JWT HS256 con `sub` UUID. `JWT_SECRET` compartida con Pizarra y Colaboración.
- **Persistencia:** PostgreSQL 16, tabla `auth.users` en el esquema `auth` de `pizarra-db`.
- **Inicio conjunto:** desde la raíz, `docker compose up --build -d`. Los puertos de Pixels (3000/8080), Pizarra (5173/8000), Colaboración (8002) y Auth (8001) no colisionan.
- **Instrucciones y pruebas:** [docs/AUTENTICACION.md](docs/AUTENTICACION.md).
