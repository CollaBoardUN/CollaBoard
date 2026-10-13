# Prototype 1 — Simple Architectural Structure

**Curso:** Arquitectura de Software (2026-II)  
**Institución:** Universidad Nacional de Colombia — Sede Bogotá  
**Docente:** Jeisson Andrés Vergara Vargas  
**Fecha:** 12 de octubre de 2026  

---

## 1. Team (Equipo)

* **Identificador del equipo:** `1e`
* **Integrantes:**
  1. Cristian Camilo García Palacios — `crgarciapa@unal.edu.co`
  2. Marlon David Pabón Muñoz — `mapabon@unal.edu.co`
  3. Jhon Edison Prieto Artunduaga — `jhprieto@unal.edu.co`
  4. David Eduardo Calderón Parra — `dcalderonpa@unal.edu.co`
  5. Juan Sebastián Leguizamón Silva — `jleguizamons@unal.edu.co`
  6. Stephan Alain Roland Garcia Martiquet — `stgarciam@unal.edu.co`

---

## 2. Software System (Sistema de Software)

### 2.1. Nombre del sistema
**CollaBoard**

### 2.2. Logo del sistema

<p align="center">
  <img src="collaboard-logo.png" alt="CollaBoard Logo" width="160" />
</p>

### 2.3. Descripción funcional y de dominio del sistema

CollaBoard es una plataforma web colaborativa en tiempo real diseñada para el trabajo visual compartido. El sistema combina dos módulos principales de interacción gráfica:

1. **Pizarra colaborativa (`pizarra-module`):** Permite a múltiples usuarios conectados simultáneamente dibujar y manipular trazos, figuras geométricas y esquemas sobre un lienzo interactivo, sincronizando cambios de estado y presencia de colaboradores en tiempo real.
2. **Lienzo colectivo de píxeles (`pixels-module`):** Espacio gráfico comunitario basado en una cuadrícula de $200 \times 200$ celdas donde los usuarios pueden modificar píxeles individuales. Para regular la interacción concurrente y evitar sobrecarga o spam, el servidor impone un temporizador de espera (*cooldown*) de 5 segundos entre cada acción por usuario.

El dominio del sistema abarca además la autenticación de usuarios mediante tokens JWT, la gestión de tableros de trabajo con control de acceso basado en roles (propietario, editor y lector) y la generación de enlaces de invitación para compartir sesiones de dibujo.

---

## 3. Architectural Structures (Estructuras Arquitectónicas)

### 3.1. Component-and-Connector (C&C) Structure

#### C&C View (Vista gráfica)

A continuación se presenta el diagrama de componentes y conectores en tiempo de ejecución, organizado en tres capas funcionales con dependencias descendentes:

```
====================================================================================================
CAPA 1: CLIENTES / FRONTENDS (WEB SPAs)
====================================================================================================
┌───────────────────────────┐ ┌───────────────────────────┐ ┌──────────────────────────────────────┐
│      pixel_frontend       │ │       auth_frontend       │ │           pizarra_frontend           │
│   React 18 / SPA (Pixels) │ │    Cliente Web (Auth)     │ │ React 19 / SPA (Pizarra y Tableros)  │
│    Docker :3000 ➔ :80     │ │     Docker Host :Web      │ │          Docker :5173 ➔ :80          │
└───────────────────────────┘ └───────────────────────────┘ └──────────────────────────────────────┘
      │               │                     │                     │            │             │
┌───────────┐   ┌───────────┐         ┌───────────┐         ┌───────────┐┌───────────┐ ┌───────────┐
│ WebSocket │   │ HTTP REST │         │ HTTP REST │         │ HTTP REST ││ WebSocket │ │ HTTP REST │
│   :8080   │   │   :8080   │         │   :8001   │         │   :8002   ││   :8000   │ │   :8000   │
│/ws/pixels │   │/api/pixels│         │   /auth   │         │  /boards  ││/ws/canvas │ │ /elements │
└───────────┘   └───────────┘         └───────────┘         └───────────┘└───────────┘ └───────────┘
      │               │                     │                     │            │             │
      ▼               ▼                     ▼                     ▼            ▼             ▼
====================================================================================================
CAPA 2: MÓDULOS DE NEGOCIO / BACKENDS (MICROSERVICIOS FASTAPI)
====================================================================================================
┌───────────────────────────┐ ┌───────────────────────────┐ ┌───────────┐ ┌────────────────────────┐
│       pixel_backend       │ │       auth_backend        │ │colabora-  │ │    pizarra_backend     │
│   FastAPI (Puerto 8080)   │ │  FastAPI (Tokens / Auth)  │ │cion_module│ │ FastAPI (Puerto 8000)  │
│  Lienzo 200×200 Cooldown  │ │    Hashing y Sesiones     │ │FastAPI:8002│ │   Salas de Dibujo WS   │
└───────────────────────────┘ └───────────────────────────┘ └───────────┘ └────────────────────────┘
              │                             │                     │                    │
┌───────────────────────────┐ ┌───────────────────────────┐ ┌───────────┐ ┌────────────────────────┐
│         TCP NoSQL         │ │          TCP SQL          │ │  TCP SQL  │ │        TCP SQL         │
│    Docker :27017:27017    │ │    Docker :5432:5432      │ │:5432:5432 │ │   Docker :5432:5432    │
│    Motor (Mongo Wire)     │ │  SQLAlchemy (PostgreSQL)  │ │SQLAlchemy │ │ SQLAlchemy (PostgreSQL)│
└───────────────────────────┘ └───────────────────────────┘ └───────────┘ └────────────────────────┘
              │                             │                     │                    │
              ▼                             ▼                     ▼                    ▼
====================================================================================================
CAPA 3: PERSISTENCIA / DATA STORES (NoSQL & SQL)
====================================================================================================
┌───────────────────────────┐ ┌────────────────────────────────────────────────────────────────────┐
│   nosql_db (MongoDB 7)    │ │                       sql_db (PostgreSQL 16)                       │
│  Docker :27017 ➔ :27017   │ │                        Docker :5432 ➔ :5432                        │
│ Colección 'pixels' (x, y) │ │    Tablas: users, credentials, boards, board_members,              │
│ Colección 'activity'      │ │             invites, elements                                      │
└───────────────────────────┘ └────────────────────────────────────────────────────────────────────┘
```

*(El diagrama interactivo para impresión y visualización vectorial se encuentra en el archivo `docs/vista_cc.html`).*

#### Descripción de estilos arquitectónicos

El diseño del prototipo implementa los siguientes estilos arquitectónicos:

1. **Cliente-Servidor en Capas (Layered Client-Server):** El sistema se divide de forma estricta en tres niveles de responsabilidad desacoplados:
   * **Capa de Presentación:** Clientes web SPA servidos mediante servidores web Nginx en contenedores independientes.
   * **Capa de Lógica de Aplicación:** Servicios de backend desarrollados en FastAPI organizados por contexto de negocio (`pixels`, `colaboracion`, `pizarra`, `auth`).
   * **Capa de Persistencia:** Almacenes de datos dedicados que resuelven las necesidades de almacenamiento sin que los clientes accedan directamente a ellos.

2. **Publicación-Suscripción / Concurrencia orientada a eventos (Publish-Subscribe sobre WebSockets):** Para los requerimientos de tiempo real (trazos concurrentes y actualización celda a celda de la matriz de píxeles), se utilizan canales WebSocket bidireccionales de baja latencia. Los clientes se suscriben a un canal (`/ws/pixels` o `/ws/canvas`) y el servidor emite eventos a todos los suscriptores conectados tan pronto ocurre una modificación de estado.

3. **Persistencia Políglota (Polyglot Persistence):** Se utilizan dos tecnologías de base de datos según el tipo de carga y estructura de datos requerida:
   * **NoSQL Documental (MongoDB):** Seleccionado para el módulo de píxeles debido a la alta frecuencia de escrituras atómicas puntuales sobre coordenadas `(x, y)` y registros cronológicos de actividad.
   * **SQL Relacional (PostgreSQL):** Seleccionado para la gestión de usuarios, membresías de tableros, permisos y relaciones de propiedad, donde la integridad referencial y las transacciones ACID son indispensables.

4. **Autenticación Desacoplada sin Estado (Stateless JWT):** El intercambio de credenciales genera un token firmado que los frontends adjuntan en los encabezados HTTP o al establecer conexiones de socket, permitiendo que los diferentes microservicios validen la identidad del usuario sin mantener sesiones en memoria compartida.

#### Descripción de elementos y relaciones

##### Componentes del sistema

| Componente | Tipo C&C | Rol y Responsabilidad | Tecnología y Runtime | Puerto Docker |
|---|---|---|---|:---:|
| `pixel_frontend` | Cliente SPA | Interfaz de usuario para la cuadrícula de píxeles. Maneja el renderizado de la matriz de $200 \times 200$, la selección de paleta y el control local del temporizador de espera. | React 18, Vite, Nginx | `3000:80` |
| `auth_frontend` | Cliente Web | Formularios de inicio de sesión y registro de cuentas de usuario; gestiona el almacenamiento local del token de acceso. | React SPA, Nginx | Host |
| `pizarra_frontend` | Cliente SPA | Interfaz para el dibujo libre sobre lienzo, navegación de tableros, control de herramientas y gestión de colaboradores. | React 19, Vite, Nginx | `5173:80` |
| `pixel_backend` | Servidor Lógico | Procesa la colocación de píxeles, aplica la validación del cooldown de 5 segundos en servidor, persiste en MongoDB y difunde cambios a los clientes conectados. | FastAPI, Python 3.12, Uvicorn | `8080:8000` |
| `auth_backend` | Servidor Lógico | Gestión de usuarios, verificación de contraseñas mediante hashing con bcrypt y emisión de tokens JWT. | FastAPI, Python 3.12 | `8001:8000` |
| `colaboracion_module` | Servidor Lógico | Gestión del ciclo de vida de los tableros, control de acceso basado en roles (owner, editor, viewer) y generación de enlaces de invitación. | FastAPI, SQLAlchemy | `8002:8000` |
| `pizarra_backend` | Servidor Lógico | Administración de sesiones de dibujo colaborativo, difusión de trazos vía WebSocket y persistencia de elementos gráficos. | FastAPI, WebSockets | `8000:8000` |
| `nosql_db` | Almacén de Datos | Almacenamiento persistente documental no relacional para la colección de coordenadas de píxeles e historial de eventos. | MongoDB 7.0 | `27017:27017` |
| `sql_db` | Almacén de Datos | Base de datos relacional para persistencia de cuentas, tableros, invitaciones, miembros y trazos vectoriales. | PostgreSQL 16 | `5432:5432` |

##### Conectores y relaciones

| Conector | Tipo | Origen ➔ Destino | Protocolo / Mecanismo | Puerto | Descripción de la Interacción |
|---|---|---|---|:---:|---|
| **C1** | WebSocket | `pixel_frontend` ➔ `pixel_backend` | WebSocket (RFC 6455) | `8080` | Flujo bidireccional continuo: envío de mensajes de colocación de píxel (`PLACE_PIXEL`) y recepción de eventos de actualización transmitidos por broadcast. |
| **C2** | HTTP REST | `pixel_frontend` ➔ `pixel_backend` | HTTP/1.1 JSON | `8080` | Peticiones síncronas de tipo Request/Response para consultar el estado completo inicial del lienzo (`/api/pixels/board`) y estadísticas agregadas. |
| **C3** | HTTP REST | `auth_frontend` ➔ `auth_backend` | HTTP/1.1 JSON | `8001` | Envío de credenciales para login y registro (`/auth/login`, `/auth/register`) y respuesta con el token JWT. |
| **C4** | HTTP REST | `pizarra_frontend` ➔ `colaboracion_module` | HTTP/1.1 JSON | `8002` | Consulta y creación de tableros (`/boards`) y gestión de miembros e invitaciones con encabezado `Authorization: Bearer <token>`. |
| **C5** | WebSocket | `pizarra_frontend` ➔ `pizarra_backend` | WebSocket (RFC 6455) | `8000` | Conexión en tiempo real para difusión y sincronización de trazos libres y posiciones de cursor entre usuarios de una misma sala. |
| **C6** | HTTP REST | `pizarra_frontend` ➔ `pizarra_backend` | HTTP/1.1 JSON | `8000` | Carga inicial y persistencia por lotes de elementos y figuras pertenecientes a un tablero específico (`/elements`). |
| **C7** | TCP Socket | `pixel_backend` ➔ `nosql_db` | Mongo Wire Protocol (TCP) | `27017` | Operaciones asíncronas de lectura y actualización atómica (`upsert`) sobre la colección de píxeles mediante el driver Motor. |
| **C8** | TCP Socket | `auth_backend` ➔ `sql_db` | PostgreSQL Protocol (TCP) | `5432` | Consultas y transacciones relacionales sobre tablas de usuarios y credenciales mediante SQLAlchemy. |
| **C9** | TCP Socket | `colaboracion_module` ➔ `sql_db` | PostgreSQL Protocol (TCP) | `5432` | Operaciones transaccionales para tablas de tableros, membresías y tokens de invitación. |
| **C10** | TCP Socket | `pizarra_backend` ➔ `sql_db` | PostgreSQL Protocol (TCP) | `5432` | Persistencia y consulta de trazos y elementos geométricos asociados a tableros. |

---

## 4. Prototype (Prototipo)

### 4.1. Prerrequisitos

* Git instalado.
* Docker Engine versión 24.0 o superior.
* Docker Compose versión 2.20 o superior.

### 4.2. Descarga del código fuente

Clonar el repositorio de la organización y ubicarse en el directorio raíz del proyecto:

```bash
git clone https://github.com/CollaBoardUN/CollaBoard.git
cd CollaBoard
```

### 4.3. Variables de entorno

El despliegue está configurado con valores por defecto preconfigurados en `docker-compose.yml` para arranque local inmediato. En caso de requerir personalización, las variables principales incluyen:

* `DATABASE_URL`: Cadena de conexión a PostgreSQL (`postgresql+asyncpg://postgres:postgres@pizarra-db:5432/collaboard_db`).
* `MONGO_URI`: Cadena de conexión a MongoDB (`mongodb://pixels-nosql-db:27017`).
* `JWT_SECRET`: Clave simétrica para firma y verificación de tokens.

### 4.4. Ejecución del sistema con Docker Compose

Para compilar las imágenes e iniciar la totalidad de los 7 contenedores en segundo plano:

```bash
docker compose up --build -d
```

### 4.5. Verificación de los servicios

Para revisar que todos los contenedores se encuentren activos y en estado saludable:

```bash
docker compose ps
```

Contenedores que deben figurar en ejecución:
* `collaboard-pizarra-frontend` (puerto `5173`)
* `collaboard-pixels-frontend` (puerto `3000`)
* `collaboard-pizarra-backend` (puerto `8000`)
* `collaboard-colaboracion-backend` (puerto `8002`)
* `collaboard-pixels-backend` (puerto `8080`)
* `collaboard-pizarra-db` (PostgreSQL, puerto `5432`)
* `collaboard-pixels-db` (MongoDB, puerto `27017`)

### 4.6. URLs de acceso local

Una vez desplegados los servicios, se puede acceder a las interfaces y APIs a través de:

* **Pizarra Colaborativa:** [http://localhost:5173](http://localhost:5173)
* **Lienzo de Píxeles (Wplace):** [http://localhost:3000](http://localhost:3000)
* **Documentación Swagger — API Pizarra:** [http://localhost:8000/docs](http://localhost:8000/docs)
* **Documentación Swagger — API Colaboración:** [http://localhost:8002/docs](http://localhost:8002/docs)
* **Documentación Swagger — API Píxeles:** [http://localhost:8080/docs](http://localhost:8080/docs)
* **Vista gráfica C&C:** Archivo local [docs/vista_cc.html](file:///c:/Users/Stef/Documents/GitHub/CollaBoard/docs/vista_cc.html)

### 4.7. Detención del sistema

Para detener y retirar los contenedores y redes virtuales del proyecto:

```bash
docker compose down
```
