# ADR 0004 · Stubs de servicios inexistentes y su reemplazo

- **Estado:** aceptada · **Fecha:** 2026-10-28 · **Paquete:** F

## Contexto
`notification-api` y `message-worker` (C#, Cristian) no existen en la rama, pero el gateway y la web
necesitan algo que responda, y el Compose debe levantar los 15 servicios del plan.

## Decisión
- `stubs/notification-api/` (respuestas JSON fijas: bandeja vacía o de ejemplo, `PATCH …/read`, `POST /internal/events` → 202, `/health`) y
  `stubs/message-worker/` (solo `/health`; **no consume RabbitMQ**). Envían `X-Collaboard-Stub` y se anuncian como stub en los logs.
- Viven en **`docker-compose.stubs.yml`**, activado por `COMPOSE_FILE` en `.env.example`. Los nombres de servicio, puertos y red
  son los definitivos (`notification-api:8080`, `message-worker`), así que **el gateway no cambia** al sustituirlos.
- **Reemplazo:** quitar `docker-compose.stubs.yml` de `COMPOSE_FILE` y definir `notification-api`/`message-worker` con `build:` al
  módulo real en la red `internal`; si el puerto o la ruta difieren, ajustar `NOTIFICATION_API_UPSTREAM` /
  `NOTIFICATION_API_PATH_PREFIX`. Detalle en `docs/p2-pendientes-coordinacion.md`.
- Para pruebas de punta a punta (CI) hay un segundo override, `docker-compose.notifications-mock.yml`, que usa el mock completo de
  la web (`web-ssr/dev/mocks`) detrás de un Nginx (ver pendientes: el mock rechaza el `Upgrade: h2c` del cliente HTTP de Chat).
- Se señala con claridad en README y en `docs/p2-despliegue.md` que son stubs: **no demuestran** la asincronía real.

## Alternativas
- *Omitir los servicios:* el gateway devolvería 502 y no se podría demostrar el enrutamiento ni el arranque completo.
- *Mock con lógica (bandeja real):* ya existe en `web-ssr/dev/mocks`; duplicarlo no aporta.

## Consecuencias
- (+) Equipo desbloqueado; reemplazo sin tocar el gateway.
- (−) Riesgo de presentar un stub como servicio real: se mitiga con marcas explícitas y con la sección «Estado actual honesto».
