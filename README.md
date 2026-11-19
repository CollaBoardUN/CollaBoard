# CollaBoard — Pizarra Colaborativa y Suite de Creación

Plataforma colaborativa modular en tiempo real donde varias personas crean, dibujan y colaboran juntas.

---

## 🚀 Prototipo 2 — arranque desde un clon limpio

Todo el servidor corre en contenedores detrás de **un único gateway Nginx** (`https://localhost:8443`;
`http://localhost:8088` solo redirige a HTTPS, ver [HTTPS](#-https-p3--s1-secure-channel)).
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
| Web SSR, API y WebSockets (mismo origen) | https://localhost:8443 (`http://localhost:8088` redirige) |
| Consola de RabbitMQ y bases (solo depuración local) | `-f docker-compose.dev-ports.yml` → `http://127.0.0.1:15672`, PostgreSQL `15432..15435`, Mongo `27017` |
| Interfaz de Pixels | http://localhost:3000 |
| Redes internas (`app` y `net-*`) | aisladas con `internal: true` (sin puertos al host ni salida a Internet; ver [Segmentación](#-segmentación-de-redes-p3--s3-network-segmentation)) |

**Verificar** (cada comando imprime `OK`/`FAIL` por comprobación):

```bash
export CURL_CA_BUNDLE=gateway/certs/ca.crt NODE_EXTRA_CA_CERTS=gateway/certs/ca.crt   # confiar en la CA local
curl -s https://localhost:8443/healthz                           # ok
sh scripts/gateway_smoke.sh https://localhost:8443               # rutas, /internal/* bloqueado, X-Request-ID
node scripts/ws_check.mjs https://localhost:8443                 # WebSocket (wss://) de Pizarra, Chat y Pixels
python security-tests/s1_tls.py                                  # S1: redirección, TLS, HSTS, cookie Secure, WSS, captura
python security-tests/s3_segmentacion.py                         # S3: matriz de conectividad por zonas y bloqueo de salida a Internet
docker compose --profile tools run --rm rabbit-smoke             # RabbitMQ: publicar/consumir, permisos, DLQ
NODE_EXTRA_CA_CERTS=gateway/tests/certs/ca.crt node --test gateway/tests/contract.test.mjs   # contrato del gateway (ver gateway/tests/compose.test.yml)
```

### 🔒 HTTPS (P3 · S1 Secure Channel)

El TLS termina en el gateway (TLS 1.2 y 1.3, HTTP/2, HSTS). El puerto `8088` solo redirige
(301) a `https://localhost:8443`; dentro de la red `internal` los servicios siguen en HTTP.

- **Certificado de desarrollo:** al arrancar, el gateway crea `gateway/certs/` (no se versiona) con
  una CA local y un certificado para `localhost`, `127.0.0.1` y `::1`. La CA solo puede firmar esos
  nombres (`nameConstraints`) y su llave privada se descarta, así que confiar en ella no habilita
  certificados para otros sitios. Para regenerarlo, borra `gateway/certs/` y reinicia el gateway.
- **Confiar en la CA** (una vez, para ver el candado sin advertencias): importa `gateway/certs/ca.crt`
  como entidad raíz: Windows `certutil -user -addstore Root gateway\certs\ca.crt`; macOS
  `sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain gateway/certs/ca.crt`;
  Linux/Firefox: *Ajustes → Privacidad y seguridad → Certificados → Importar*.
- **Desde otra máquina de la LAN:** `TLS_EXTRA_SAN=IP:<ip-del-servidor>` en `.env`, borra
  `gateway/certs/` y reinicia el gateway; usa `PUBLIC_ORIGIN=https://<ip>:8443` y
  `CHAT_ALLOWED_ORIGINS` con ese mismo origen.
- **Producción:** monta el certificado real (`server.crt`, `server.key`) en `gateway/certs/` (el
  script no lo reemplaza) y sube `TLS_HSTS_MAX_AGE` a `31536000`.
- **Evidencia con Wireshark** (escenario S1): `python security-tests/s1_wireshark.py --headed --out <carpeta>`
  captura con Wireshark en la interfaz de loopback mientras un navegador usa la web. Guía para abrir
  las capturas en Wireshark: [docs/p3/evidencia/S1/wireshark/](docs/p3/evidencia/S1/wireshark/README.md).
- Si tu `.env` viene del P2, copia de nuevo las variables de *Acceso público* de `.env.example`
  (`PUBLIC_ORIGIN`, `CHAT_ALLOWED_ORIGINS`, `SESSION_COOKIE_SECURE`, `GATEWAY_TLS_PORT`).

### 🧱 Segmentación de redes (P3 · S3 Network Segmentation)

En lugar de una sola red plana `internal`, los contenedores se reparten en **8 redes** según lo que cada uno necesita ([ADR 0013](docs/adr/0013-segmentacion-de-redes-por-zonas.md)):
- **`edge`**: única red con salida al host (`gateway` y `pixels-ui`).
- **`app` (`internal: true`)**: solo `gateway`, `web-ssr` y las 6 APIs HTTP (sin bases de datos, sin RabbitMQ, sin `message-worker` y sin Internet).
- **6 redes de datos y mensajería (`internal: true`)**: `net-user` (`auth-api` + `user-db`), `net-board` (`collaboration-api` + `board-db`), `net-canvas` (`pizarra-api` + `canvas-db`), `net-notif` (`notification-api` + `message-worker` + `notification-db`), `net-mongo` (`chat-api` + `pixels-api` + `pixels-nosqldb`) y `net-mq` (`notification-api` + `message-worker` + `rabbitmq`).
- **Verificación de la matriz:** `python security-tests/s3_segmentacion.py` (o `sh scripts/segmentation_check.sh`) inyecta `nicolaka/netshoot` en el namespace de red de cada contenedor para probar todos los pares permitidos y prohibidos más la salida a Internet.
- **Abrir puertos de bases o la consola de RabbitMQ (`15672`) en local:** como Docker no publica puertos desde redes `internal: true`, añade `-f docker-compose.dev-ports.yml` al levantar si necesitas entrar desde el host.
- **Prueba de rendimiento de `pixels-api` (Rust) y costo de segmentación:** ver [rendimiento/pixels/README.md](rendimiento/pixels/README.md).

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
