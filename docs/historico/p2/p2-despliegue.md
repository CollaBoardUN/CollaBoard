# Vista de despliegue del prototipo 2

Coherente con [`docker-compose.yml`](../docker-compose.yml) (servicios, redes, puertos y volúmenes
reales). Decisiones: [docs/adr/](adr/). Pendientes de otros paquetes: [p2-pendientes-coordinacion.md](p2-pendientes-coordinacion.md).

## Diagrama

```mermaid
flowchart LR
  subgraph CLIENTE["Host cliente"]
    NAV["Navegador<br/>web SSR"]
  end

  subgraph DOCKER["Host Docker (Compose, proyecto «collaboard»)"]
    direction TB
    subgraph EDGE["red edge"]
      GW["gateway<br/>Nginx<br/>:80 → host :8088<br/>:8081 solo interno"]
      PXUI["pixels-ui (perfil opcional)<br/>host :3000"]
    end
    subgraph INTERNAL["red internal (sin puertos al host)"]
      WEB["web-ssr<br/>Next.js :3000"]
      AUTH["auth-api · Go :8001"]
      COLLAB["collaboration-api · Python :8000"]
      PIZ["pizarra-api · Python :8000"]
      CHAT["chat-api · Java :8090"]
      PIX["pixels-api · Python :8000"]
      NOTI["notification-api · C# :8080<br/>(stub hoy)"]
      WORK["message-worker · C#<br/>(stub hoy)"]
      MQ["rabbitmq<br/>AMQP :5672 · consola :15672 → 127.0.0.1"]
      UDB[("user-db<br/>PostgreSQL")]
      BDB[("board-db<br/>PostgreSQL")]
      CDB[("canvas-db<br/>PostgreSQL + JSONB")]
      NDB[("notification-db<br/>PostgreSQL")]
      MONGO[("pixels-nosqldb<br/>MongoDB: collaboard_pixels + chat")]
    end
  end

  NAV -- "C01/C03 HTTP + WS :8088" --> GW
  ELE -- "C03 HTTP Bearer + WS (handshake)<br/>COLLABOARD_GATEWAY" --> GW
  GW -- "C01 páginas" --> WEB
  WEB -- "C02 HTTP :8081 (sin páginas)" --> GW
  GW -- "C04 HTTP" --> AUTH & COLLAB & PIZ & CHAT & PIX & NOTI
  GW -. "C04 WS" .-> PIZ & CHAT & PIX
  PIZ -- "C05 permisos (HTTP interno)" --> COLLAB
  CHAT -- "C05 permisos" --> COLLAB
  COLLAB -- "C06 evento invite.accepted" --> NOTI
  CHAT -- "C06 evento chat.message.created" --> NOTI
  NOTI -- "C07 AMQP publica (confirmado)" --> MQ
  MQ -- "C07 AMQP consume (ack manual)" --> WORK
  AUTH -- "C08" --> UDB
  COLLAB -- "C09" --> BDB
  PIZ -- "C10" --> CDB
  PIX -- "C11 (credencial pixels)" --> MONGO
  CHAT -- "C11 (credencial chat)" --> MONGO
  NOTI -- "C12" --> NDB
  WORK -- "C12" --> NDB
  PXUI -- "HTTP/WS vía gateway" --> GW
```

## Contenedores, puertos y volúmenes

| Servicio (Compose) | Imagen / origen | Puerto en contenedor | Publicado al host | Red | Volumen |
|---|---|---|---|---|---|
| `gateway` | `gateway/` (nginx:1.27-alpine) | 80 público, 8081 interno | **8088→80** | edge + internal | — |
| `web-ssr` | `web-ssr/` | 3000 | — | internal | — |
| `auth-api` | `authentication-module/` | 8001 | — | internal | — |
| `collaboration-api` | `colaboracion-module/` | 8000 | — | internal | — |
| `pizarra-api` | `pizarra-module/pizarra-backend/` | 8000 | — | internal | — |
| `chat-api` | `chat-module/` | 8090 | — | internal | — |
| `pixels-api` | `pixels-module/pixel-backend/` | 8000 | — | internal | — |
| `notification-api` | `stubs/notification-api/` (stub) | 8080 | — | internal | — |
| `message-worker` | `stubs/message-worker/` (stub) | 8080 (solo /health) | — | internal | — |
| `rabbitmq` | `rabbitmq/` (3.13-management) | 5672, 15672 | **127.0.0.1:15672** | internal | `rabbitmq_data` |
| `user-db` (D1) | postgres:16-alpine | 5432 | — | internal | `user_db_data` |
| `board-db` (D2) | postgres:16-alpine | 5432 | — | internal | `board_db_data` |
| `canvas-db` (D3) | postgres:16-alpine | 5432 | — | internal | `canvas_db_data` |
| `notification-db` (D5) | postgres:16-alpine | 5432 | — | internal | `notification_db_data` |
| `pixels-nosqldb` (D4) | mongo:7 | 27017 | — | internal | `pixels_mongo_data` |
| `pixels-ui` (perfil `pixels-ui`) | `pixels-module/pixel-frontend/` | 80 | **3000** | edge | — |

Cinco almacenes de datos, dos motores (PostgreSQL y MongoDB). RabbitMQ no cuenta como base de datos.

## Catálogo de conectores de infraestructura

| ID | Origen → destino | Protocolo | Cómo lo resuelve la infraestructura |
|---|---|---|---|
| C01 | Navegador → web SSR | HTTP | `location /` del gateway público |
| C02 | web SSR → gateway | HTTP interno | Segundo `server` del gateway en `:8081`, **solo en la red `internal`** y **sin `location /`**: el SSR no puede pedirse páginas a sí mismo (sin bucles). Sin límite de tasa (una sola IP origen). Ver [ADR 0002](adr/0002-ruta-interna-ssr-gateway.md) |
| C03 | Navegador → gateway | HTTP REST + WebSocket | Único puerto público (`8088`). Cookie `cb_session` (web) o `Authorization: Bearer`, reenviadas sin modificar |
| C04 | Gateway → 6 APIs | HTTP; WS a Pizarra, Chat y Pixels | Plantillas envsubst; `Upgrade`/`Connection`, HTTP/1.1, `proxy_read_timeout 1h` en WS; reescritura de rutas de Pizarra ([ADR 0001](adr/0001-gateway-nginx-y-reescritura-de-rutas.md)) |
| C07 | NotificationAPI → RabbitMQ → worker | AMQP | vhost `collaboard`, exchange `notifications.events`, cola quorum `notifications.tasks` con DLQ; usuarios de mínimo privilegio ([ADR 0005](adr/0005-topologia-rabbitmq-y-permisos.md)) |
| C11 | Pixels / Chat → MongoDB | Protocolo MongoDB | Dos bases (`collaboard_pixels`, `chat`) con **usuarios separados** y rol `readWrite` solo sobre la suya ([ADR 0010](adr/0010-mongodb-bases-y-credenciales-separadas.md)) |

C05, C06 y C08–C10, C12 son conexiones de las propias APIs a su destino dentro de la red `internal`
(nombres DNS de Compose); la infraestructura solo garantiza alcanzabilidad y orden de arranque
(`depends_on` con `service_healthy`).

## Patrones de despliegue

Gateway / punto de entrada único · segmentación en redes (`edge`/`internal`) · una base por dominio
(persistencia políglota) · contenedor por servicio con *healthcheck* y arranque ordenado · volumen con nombre
por almacén · configuración por variables de entorno (12-factor) · *stubs* intercambiables por el servicio real
sin tocar el gateway.

## Estado actual honesto

- `notification-api` y `message-worker` son **stubs** (no consumen RabbitMQ). El broker, sus permisos y la DLQ
  están verificados con `scripts/rabbit_smoke_test.py`, no con el flujo real.
- Pizarra aún lleva su propia copia del CRUD de tableros; para el recorrido completo se usa el override
  `docker-compose.compat-shared-db.yml` (ver pendientes).
