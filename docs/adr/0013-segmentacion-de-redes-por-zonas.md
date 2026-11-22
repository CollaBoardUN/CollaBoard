# ADR 0013 · Segmentación de redes por zonas y almacén (S3)

- **Estado:** aceptada · **Fecha:** 2026-11-19 · **Escenario:** P3 · S3 Network Segmentation (Stephan García)

## Contexto
En el P2 ([ADR 0003](0003-redes-y-puertos-publicados.md)) teníamos solo dos redes bridge: `edge` e `internal` (sin `internal: true`). Los 15 servicios internos compartían `internal` y su DNS (`127.0.0.11`). Con eso:

1. Si alguien comprometía cualquier contenedor (por ejemplo `pixels-api` o `web-ssr`), desde ahí alcanzaba por TCP las 5 bases de datos y RabbitMQ.
2. Como `internal` no tenía `internal: true`, todos los contenedores (incluidas las bases de datos) tenían salida a Internet.

## Decisión
Partir `internal` en **7 redes internas con `internal: true`** más la red `edge`:

| Red | `internal` | Quién se conecta | Para qué sirve |
|---|---|---|---|
| `edge` | `false` | `gateway`, `pixels-ui` | Única red con puertos publicados al host |
| `app` | `true` | `gateway`, `web-ssr`, `auth-api`, `collaboration-api`, `pizarra-api`, `chat-api`, `pixels-api`, `notification-api` | Tráfico HTTP/WS entre el gateway, el SSR y las APIs |
| `net-user` | `true` | `auth-api`, `user-db` | Base de usuarios y hashes de contraseñas |
| `net-board` | `true` | `collaboration-api`, `board-db` | Tableros, miembros y permisos |
| `net-canvas` | `true` | `pizarra-api`, `canvas-db` | Estado y versiones de la pizarra |
| `net-notif` | `true` | `notification-api`, `message-worker`, `notification-db` | Bandeja de notificaciones |
| `net-mongo` | `true` | `chat-api`, `pixels-api`, `pixels-nosqldb` | MongoDB (bases `chat` y `collaboard_pixels`) |
| `net-mq` | `true` | `notification-api`, `message-worker`, `rabbitmq`, `rabbit-smoke` | Broker AMQP RabbitMQ |

Ajustes necesarios por usar `internal: true`:
- **`message-worker` fuera de `app`:** el worker no recibe HTTP ni llama a otras APIs, así que solo se conecta a `net-notif` y `net-mq`.
- **Consola de RabbitMQ (`127.0.0.1:15672`):** Docker no publica puertos al host desde una red `internal: true`. Para no abrir `net-mq` en producción ni en el CI, el puerto `127.0.0.1:15672` se movió a `docker-compose.dev-ports.yml` (que pone `internal: false` solo cuando se levanta con ese archivo para depurar en local).
- **`rabbit-smoke`:** antes hacía `pip install pika` al arrancar; como en `net-mq` ya no hay Internet, ahora instala `pika` en el `build` (`scripts/Dockerfile.rabbit-smoke`).

## Alternativas
- *Dejar una sola red `internal` y confiar solo en las contraseñas de cada base:* no evita escaneo de puertos internos, fallos pre-autenticación del motor ni salida a Internet.
- *Tres redes (`edge`, `app`, `datos` compartida por todas las bases):* quita al gateway y al SSR de la red de datos, pero cualquier API que use una base seguiría viendo las otras cuatro bases y RabbitMQ.
- *Separar MongoDB en dos contenedores (`chat-mongo` y `pixels-mongo`):* quitaría el único almacén compartido en `net-mongo`, pero suma otro proceso `mongod` en memoria. Se mantiene un solo `pixels-nosqldb` con usuarios y bases separadas ([ADR 0010](0010-mongodb-bases-y-credenciales-separadas.md)) y se deja documentado como riesgo residual.

## Consecuencias
- (+) Los 45 pares prohibidos hacia bases de datos y RabbitMQ quedan bloqueados (no resuelven por DNS ni tienen ruta), `message-worker` no ve ninguna de las 8 interfaces de `app`, y los 14 contenedores internos quedan sin salida a Internet.
- (−) **Riesgo residual en `net-mongo`:** `chat-api` y `pixels-api` siguen viendo el puerto `27017` de `pixels-nosqldb`; ahí la separación es por credenciales de MongoDB (ADR 0010).
- (−) Para abrir puertos de bases o la consola `15672` desde la máquina local hay que pasar `-f docker-compose.dev-ports.yml` o entrar con `docker compose exec`.
