# Prototype 1 — Simple Architectural Structure

**Curso:** Arquitectura de Software (2026-II)  
**Institución:** Universidad Nacional de Colombia — Sede Bogotá  
**Docente:** Jeisson Andrés Vergara Vargas  
**Fecha:** 12 de octubre de 2026  

---

## 1. Team (Equipo)

- **Identificador del equipo:** 1e  
- **Integrantes:**  
  1. Cristian Camilo García Palacios — crgarciapa@unal.edu.co  
  2. Marlon David Pabón Muñoz — mapabon@unal.edu.co  
  3. Jhon Edison Prieto Artunduaga — jhprieto@unal.edu.co  
  4. David Eduardo Calderón Parra — dcalderonpa@unal.edu.co  
  5. Juan Sebastián Leguizamón Silva — jleguizamons@unal.edu.co  
  6. Stephan Alain Roland Garcia Martiquet — stgarciam@unal.edu.co  

---

## 2. Software System (Sistema de Software)

### 2.1. Nombre del sistema
CollaBoard

### 2.2. Logo del sistema
![Logo CollaBoard](docs/logo.png)

### 2.3. Descripción funcional y de dominio del sistema
CollaBoard es una plataforma web orientada al trabajo colaborativo visual en tiempo real. La solución integra herramientas de dibujo libre junto con dinámicas de interacción comunitaria sobre lienzos compartidos, organizada en cuatro módulos funcionales:

- **Pizarra colaborativa (`pizarra-module`):** Espacio de trabajo sincrónico para dibujo a mano alzada y creación de figuras geométricas donde múltiples usuarios interactúan simultáneamente en un mismo tablero.
- **Lienzo de píxeles (`pixels-module`):** Lienzo compartido de 200×200 celdas inspirado en dinámicas colectivas, con temporizador de enfriamiento (*cooldown*) de 5 segundos por usuario para moderar la puesta de pixeles.
- **Gestión de tableros y colaboración (`colaboracion-module`):** Administración del ciclo de vida de los tableros, control de acceso mediante roles (propietario, editor y lector) y generación de enlaces de invitación.
- **Autenticación e identidad (`authentication-module`):** Servicio centralizado en Go que gestiona el registro e inicio de sesión de usuarios, almacenamiento seguro de contraseñas mediante derivación con Argon2id y expedición de tokens JWT.

---

## 3. Architectural Structures (Estructuras Arquitectónicas)

### 3.1. Component-and-Connector (C&C) Structure

#### Vista C&C (C&C View)
![Diagrama C&C CollaBoard](docs/Vista_CC_FINAL.jpeg)

#### Estilos Arquitectónicos
El sistema adopta una combinación de estilos arquitectónicos para responder a las demandas de separacion de responsabilidades y concurrencia en tiempo real:

1. **Cliente-Servidor en Capas:**
   - **Capa de Presentación:** Clientes web SPA construidos en React y servidos de forma aislada a través de Nginx en contenedores independientes.
   - **Capa de Lógica:** Servicios backend segmentados por límites de contexto y construidos de forma políglota (Go para el servicio de autenticación; Python con FastAPI para tableros, dibujo y píxeles).
   - **Capa de Datos:** Persistencia segregada donde cada servicio accede de forma exclusiva a su respectivo motor de base de datos.

2. **Publicador-Suscriptor (Pub/Sub) con WebSockets:**
   Mecanismo de transporte bidireccional sobre WebSockets para la difusión instantánea de eventos de dibujo y cambios de estado en la matriz de píxeles hacia todos los clientes de  la sesión.

3. **Arquitectura Orientada a Servicios (SOA / Microservicios):**
   Separacion del sistema en servicios autónomos empaquetados en contenedores independientes, comunicados externamente vía HTTP/REST y WebSockets.

#### Decisiones de Diseño y Persistencia
- **Persistencia Políglota:** Se seleccionó MongoDB (NoSQL) para el almacenamiento de la matriz de píxeles debido a su flexibilidad y alto rendimiento en operaciones frecuentes de lectura/escritura de coordenadas `(x, y)`. Ademas, se emplea PostgreSQL (relacional) para el modelo relacional estricto requerido en usuarios, tableros, membresías y trazos del tablero.
- **Seguridad y Autorización sin Estado (Stateless JWT):** El servicio de autenticación emite tokens firmados (HS256). Los servicios de colaboración y pizarra validan de forma local e independiente la firma y vigencia del token mediante un secreto compartido (`JWT_SECRET`), eliminando dependencias de red en tiempo de ejecución o almacenamiento centralizado de sesiones.

---

### Descripción de elementos y relaciones

#### Componentes del sistema

| Componente | Tipo C&C | Rol y Responsabilidad | Tecnología y Runtime | Puerto Docker |
| :--- | :--- | :--- | :--- | :--- |
| `pixel_frontend` | Cliente SPA | Interfaz para interacción con el lienzo de píxeles, paleta de colores y control visual del tiempo de enfriamiento. | React 18, Vite, Nginx | 3000:80 |
| `auth_frontend` | Cliente Web | Vistas de inicio de sesión y registro integradas en el cliente web; gestión local del token JWT. | React SPA, Nginx | 5173:80 |
| `pizarra_frontend` | Cliente SPA | Interfaz gráfica del lienzo de dibujo vectorial, presencia de usuarios y administración de salas. | React 19, Vite, Nginx | 5173:80 |
| `pixel_backend` | Servidor Lógico | Servicio de píxeles: control de cooldown de 5s, persistencia en MongoDB y difusión por WebSockets. | FastAPI, Python 3.12, Uvicorn | 8080:8000 |
| `auth_backend` | Servidor Lógico | Servicio de identidad en Go: validación de credenciales con hash Argon2id y emisión de JWT. | Go + Chi | 8001:8001 |
| `colaboracion_module` | Servidor Lógico | Gestión de tableros, niveles de acceso (dueño, editor, lector) e invitaciones. | FastAPI, Python 3.12, SQLAlchemy | 8002:8000 |
| `pizarra_backend` | Servidor Lógico | Gestión de salas de dibujo en tiempo real, difusión de trazos vectoriales y persistencia de trazos. | FastAPI, Python 3.12, WebSockets | 8000:8000 |
| `nosql_db` | Almacén de Datos | Base de datos documental para el estado del tablero de píxeles y el registro histórico de colocaciones. | MongoDB 7.0 | 27017:27017 |
| `sql_db` | Almacén de Datos | Base de datos relacional para usuarios, tableros, permisos y metadatos de trazos. | PostgreSQL 16 | 5432:5432 |

#### Conectores y relaciones

| Conector | Tipo | Origen → Destino | Protocolo / Mecanismo | Puerto | Descripción de la Interacción |
| :--- | :--- | :--- | :--- | :--- | :--- |
| C1 | HTTP REST | `pixel_frontend` → `pixel_backend` | HTTP/1.1 JSON | 8080 | Consulta del estado inicial del tablero (`/api/pixels/board`) y métricas de actividad. |
| C2 | WebSocket | `pixel_frontend` → `pixel_backend` | WebSocket | 8080 | Envío de píxeles y recepción en tiempo real de actualizaciones del lienzo para todos los clientes conectados. |
| C3 | HTTP REST | `auth_frontend` → `auth_backend` | HTTP/1.1 JSON | 8001 | Peticiones de registro e inicio de sesión (`/auth/register`, `/auth/login`) para obtención del token JWT. |
| C4 | HTTP REST | `pizarra_frontend` → `colaboracion_module` | HTTP/1.1 JSON (Bearer JWT) | 8002 | Operaciones CRUD sobre tableros, gestión de miembros e invitaciones adjuntando token en cabecera HTTP. |
| C5 | WebSocket | `pizarra_frontend` → `pizarra_backend` | WebSocket | 8000 | Transmisión y recepción bidireccional de eventos y trazos de dibujo en vivo entre participantes. |
| C6 | HTTP REST | `pizarra_frontend` → `pizarra_backend` | HTTP/1.1 JSON (Bearer JWT) | 8000 | Carga y persistencia de trazos, capas y elementos del lienzo. |
| C7 | TCP Socket | `pixel_backend` → `nosql_db` | Protocolo MongoDB (TCP) | 27017 | Operaciones de lectura y escritura del estado de los píxeles utilizando el driver Motor. |
| C8 | TCP Socket | `auth_backend` → `sql_db` | Protocolo PostgreSQL (TCP) | 5432 | Consultas y persistencia de cuentas de usuario en el esquema de autenticación. |
| C9 | TCP Socket | `colaboracion_module` → `sql_db` | Protocolo PostgreSQL (TCP) | 5432 | Persistencia relacional de tableros, roles e invitaciones. |
| C10 | TCP Socket | `pizarra_backend` → `sql_db` | Protocolo PostgreSQL (TCP) | 5432 | Almacenamiento de trazos y datos estructurales de las pizarras. |

> **Nota sobre autenticación:** La validación de credenciales se maneja de forma descentralizada mediante tokens JWT. Tras obtener el token desde `auth_backend`, los clientes web lo envían en la cabecera `Authorization: Bearer <token>` a los servicios de colaboración y dibujo. Estos servicios validan la firma criptográfica localmente utilizando el secreto compartido configurado en su entorno (`JWT_SECRET`), sin requerir llamadas sincrónicas al servicio de autenticación en tiempo de ejecución.

---

## 4. Prototype (Prototipo)

### 4.1. Requisitos previos
- Git 2.x o superior
- Docker Engine 24.0+
- Docker Compose 2.20+

### 4.2. Descarga del código fuente
```bash
git clone https://github.com/CollaBoardUN/CollaBoard.git
cd CollaBoard
```

### 4.3. Variables de entorno
El archivo `docker-compose.yml` incluye la configuración base por defecto para el despliegue local:

- `DATABASE_URL`: Conexión de los servicios de Python a PostgreSQL (`postgresql+psycopg://postgres:postgres@pizarra-db:5432/pizarra`).
- `AUTH_DATABASE_URL`: Cadena de conexión del servicio en Go (`postgres://postgres:postgres@pizarra-db:5432/pizarra?sslmode=disable`).
- `MONGODB_URL`: Conexión del servicio de píxeles a MongoDB (`mongodb://pixels-nosql-db:27017`).
- `JWT_SECRET`: Llave compartida entre servicios para la verificación de firmas JWT.
- `FRONTEND_URL`: Origen permitido por las políticas CORS de los backends (`http://localhost:5173`).

### 4.4. Ejecución del sistema
Para compilar las imágenes e iniciar la infraestructura completa en segundo plano:
```bash
docker compose up --build -d
```

Verificación del estado de los contenedores:
```bash
docker compose ps
```

Contenedores inicializados por la plataforma (8 en total):
- `collaboard-pizarra-frontend` (Puerto 5173)
- `collaboard-pixels-frontend` (Puerto 3000)
- `collaboard-pizarra-backend` (Puerto 8000)
- `collaboard-colaboracion-backend` (Puerto 8002)
- `collaboard-pixels-backend` (Puerto 8080)
- `collaboard-authentication-backend` (Puerto 8001)
- `collaboard-pizarra-db` (PostgreSQL, Puerto 5432)
- `collaboard-pixels-db` (MongoDB, Puerto 27017)

### 4.5. Puntos de acceso local
- **Cliente Pizarra y Acceso Principal:** `http://localhost:5173`
- **Lienzo de Píxeles:** `http://localhost:3000`
- **Healthcheck Autenticación (Go):** `http://localhost:8001/health`
- **Documentación Swagger Pizarra:** `http://localhost:8000/docs`
- **Documentación Swagger Colaboración:** `http://localhost:8002/docs`
- **Documentación Swagger Píxeles:** `http://localhost:8080/docs`

### 4.6. Detención del entorno
Para detener y remover los contenedores junto con sus redes virtuales:
```bash
docker compose down
```
