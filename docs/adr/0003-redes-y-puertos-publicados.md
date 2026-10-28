# ADR 0003 · Redes y puertos publicados

- **Estado:** aceptada · **Fecha:** 2026-10-28 · **Paquete:** F

## Contexto
El P1 publicaba cada servicio y cada base (5432, 27017, 8000, 8001, 8002, 8080…) y compartía una sola base
PostgreSQL. El P2 exige «un único gateway» y «los clientes no acceden a ninguna base directamente».

## Decisión
- Dos redes *bridge*: **`edge`** (solo `gateway` y la UI opcional de Pixels) e **`internal`** (APIs, bases, broker, worker, SSR).
- Al host solo se publican: el **gateway** (`${GATEWAY_PORT:-8088}:80`) y la **consola de RabbitMQ**
  (`127.0.0.1:15672`, solo desde la máquina local, configurable con `RABBITMQ_CONSOLE_BIND`).
- Las bases (cinco almacenes: `user-db`, `board-db`, `canvas-db`, `notification-db`, `pixels-nosqldb`) y el AMQP (5672) **no se publican**.
  Para depurar existe `docker-compose.dev-ports.yml`, que los abre solo en `127.0.0.1` y no se usa en demos.
- Un volumen con nombre por almacén (`user_db_data`, `board_db_data`, `canvas_db_data`, `notification_db_data`,
  `pixels_mongo_data`, `rabbitmq_data`): reiniciar contenedores **no borra datos** (probado reiniciando RabbitMQ con mensajes pendientes).
- `healthcheck` en todos los servicios y `depends_on: condition: service_healthy`; logs con rotación (`json-file` 10 MB × 3).
- Secretos: `.env.example` versionado con valores de **desarrollo**; `.env` ignorado por git. Variables obligatorias
  (`JWT_SECRET`, `NOTIFICATIONS_SERVICE_TOKEN`) fallan al arrancar si faltan (`${VAR:?…}`).

## Alternativas
- *Una red plana:* cualquier contenedor alcanza cualquier base; no refleja la separación del C&C.
- *Publicar bases para comodidad:* expone datos y contradice el requisito.

## Consecuencias
- (+) Superficie expuesta mínima y coherente con la vista de despliegue (`docs/p2-despliegue.md`).
- (−) Depurar una base exige el override de puertos o `docker compose exec`.
- (−) Las contraseñas de desarrollo por defecto deben cambiarse fuera de la máquina local.
