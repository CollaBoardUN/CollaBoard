# CollaBoard — Pizarra Colaborativa y Suite de Creación

Plataforma colaborativa modular en tiempo real donde varias personas crean, dibujan y colaboran juntas.

---

## 🚀 Prototipo 2 — arranque desde un clon limpio

Todo el servidor corre en contenedores detrás de **un único gateway Nginx** (`http://localhost:8088`).
Vista de despliegue y decisiones: [docs/p2-despliegue.md](docs/p2-despliegue.md) · [docs/adr/](docs/adr/) ·
pendientes con el equipo: [docs/p2-pendientes-coordinacion.md](docs/p2-pendientes-coordinacion.md).

**Prerrequisitos:** Docker Desktop / Engine con Compose v2.24+ (el stack completo usa ≈1 GiB de RAM en reposo; dale al menos 4 GiB a Docker para compilar),
Node.js 20+ (solo para las pruebas de WebSocket) y Python 3.12 (solo para el E2E web).

```bash
git clone https://github.com/CollaBoardUN/CollaBoard.git && cd CollaBoard
git checkout gateway/nginx-rabbitmq            # rama del paquete F (hasta que se integre a main)

cp .env.example .env                           # valores SOLO de desarrollo; cámbialos fuera de tu máquina
docker compose up -d --build --wait            # construye e inicia los 15 servicios, espera a que estén sanos
docker compose ps                              # todos deben aparecer "healthy"
```

`.env.example` activa `docker-compose.stubs.yml` (stubs de NotificationAPI y MessageWorker, que
aún no existen en la rama). Si Pizarra todavía consulta permisos por SQL en la base de
Colaboración (trabajo pendiente de David/Estefan), para el recorrido de dibujo completo añade
los overrides de pruebas:

```bash
export COMPOSE_FILE=docker-compose.yml:docker-compose.stubs.yml:docker-compose.compat-shared-db.yml:docker-compose.notifications-mock.yml
docker compose up -d --build --wait
```

| Qué | Dónde |
|---|---|
| Web SSR, API y WebSockets (mismo origen) | http://localhost:8088 |
| Consola de RabbitMQ (solo desde esta máquina) | http://localhost:15672 (`RABBITMQ_ADMIN_USER` / `RABBITMQ_ADMIN_PASSWORD` de `.env`) |
| Interfaz de Pixels (opcional: `docker compose --profile pixels-ui up -d`) | http://localhost:3000 |
| Bases de datos y brokers | no se publican; para depurar: `-f docker-compose.dev-ports.yml` |

**Verificar** (cada comando imprime `OK`/`FAIL` por comprobación):

```bash
curl -s localhost:8088/healthz                                   # ok
sh scripts/gateway_smoke.sh http://localhost:8088                # rutas, /internal/* bloqueado, X-Request-ID
node scripts/ws_check.mjs http://localhost:8088                  # WebSocket de Pizarra, Chat y Pixels
docker compose --profile tools run --rm rabbit-smoke             # RabbitMQ: publicar/consumir, permisos, DLQ
node --test gateway/tests/contract.test.mjs                      # contrato del gateway (ver gateway/tests/compose.test.yml)
```

**Logs correlacionados:** cada petición lleva `X-Request-ID`; el gateway lo escribe en su log
de acceso (`docker compose logs gateway | grep rid=`) y lo reenvía a los servicios.

**Detener:** `docker compose down` (conserva los volúmenes) · `docker compose down -v` (borra los datos).
Reiniciar un servicio sin perder datos: `docker compose restart <servicio>`.


> Lo que sigue en este README describe el **prototipo 1** (se conserva en `docker-compose.p1.yml`).

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
- **Inicio conjunto (P1):** desde la raíz, `docker compose -f docker-compose.p1.yml up --build -d`. Los puertos de Pixels (3000/8080), Pizarra (5173/8000), Colaboración (8002) y Auth (8001) no colisionan.
- **Instrucciones y pruebas:** [docs/AUTENTICACION.md](docs/AUTENTICACION.md).

---

## 🌐 Prototipo 2 — Web SSR (`web-ssr`)

Presentación web con renderizado en el servidor (Next.js 16 + TypeScript): dashboard y
cabecera de cada tablero renderizados por petición, sesión en cookie HttpOnly, lienzo y
tiempo real hidratados en el navegador, chat por tablero y bandeja de notificaciones.

```bash
# Desde la raíz: prototipo 2 integrado con servicios reales
# Primera instalación: copiar .env.example a .env y ajustar valores
docker compose -p collaboard -f docker-compose.yml -f notifications-module/compose.gateway.yml up --build -d
# -> http://localhost:8088
```

- Guía del módulo y pruebas: [web-ssr/README.md](web-ssr/README.md)
- Diseño, seguridad y vista de capas: [docs/p2/WEB_SSR.md](docs/p2/WEB_SSR.md)
- Contratos de Chat y Notificaciones: [docs/p2/CONTRATOS_WEB.md](docs/p2/CONTRATOS_WEB.md)
- Revisión de la integración: [docs/p2/INTEGRACION_FINAL.md](docs/p2/INTEGRACION_FINAL.md)
