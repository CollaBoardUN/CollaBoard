# ADR 0001 · Gateway Nginx, enrutamiento y reescritura de rutas

- **Estado:** aceptada · **Fecha:** 2026-10-28 · **Paquete:** F (Sebastian)

## Contexto
El plan P2 (sección 4) exige un único punto de entrada HTTP/WS que enrute a seis APIs, propague un
identificador de solicitud y controle límites básicos, **sin lógica de permisos de negocio** (cada API valida
su JWT y autoriza). Los puertos y rutas definitivos de algunos servicios (Notificaciones C#, Chat) aún no existen.

## Decisión
- **Nginx** (`gateway/`, imagen `nginx:1.27-alpine`). La configuración se **renderiza al arrancar** desde
  `gateway/templates/*.template` con `envsubst`: upstreams, rutas y prefijos son variables de entorno
  (`AUTH_API_UPSTREAM`, `NOTIFICATION_API_PATH_PREFIX`, `PIZARRA_BOARDS_PATH`, …), así un cambio de puerto o ruta de otro
  servicio es una variable y no un cambio de código.
- `proxy_pass` con **variable** + `resolver 127.0.0.11`: Nginx vuelve a resolver el nombre DNS de Compose, por lo que
  arranca aunque un servicio todavía no exista y tolera recrearlo con otra IP.
- **Reescrituras** (las rutas públicas ≠ rutas internas de los servicios existentes):

  | Pública | Interna |
  |---|---|
  | `/api/auth/*` | `/auth/*` (Auth Go) |
  | `/api/boards[/*]` | `/boards[/*]` (Colaboración) |
  | `/api/invites/*` | `/invites/*` (Colaboración) |
  | `/api/canvas/boards/{id}/state` | `/boards/{id}/state` (Pizarra) |
  | `/api/canvas/boards/{id}/versions[/{v}[/restore]]` | `/boards/{id}/versions…` (Pizarra) |
  | `/ws/boards/{id}` | `/ws/boards/{id}` (Pizarra) |
  | `/api/chat/*`, `/ws/chat/*`, `/api/pixels/*`, `/ws/pixels` | sin cambio |
  | `/api/notifications[/{id}/read]` | `${NOTIFICATION_API_PATH_PREFIX}[…]` (por defecto igual) |

  Los segmentos capturados en las rutas con reescritura se restringen a `[A-Za-z0-9_-]{1,64}` para que no se pueda
  inyectar saltos de línea ni rutas ajenas en la URL reescrita.
- `/internal/*` se bloquea con una *location* regex insensible a mayúsculas **en cualquier posición** del camino
  (`(^|/)internal(/|$)` → 404 JSON). Verificado con 13 variantes en `gateway/tests/contract.test.mjs`.
- `Authorization`, `Cookie` y `Origin` **no se tocan**; solo se añaden `X-Request-ID` y `X-Forwarded-*`.
- `X-Request-ID`: se respeta el entrante si cumple `^[A-Za-z0-9._-]{8,64}$` (evita inyección en logs); si no, se
  genera uno. Se devuelve en la respuesta y se escribe en el log de acceso como `rid=…`. El log **omite la query
  string** porque puede llevar credenciales (ver transición del WS de Pizarra).
- **Transición Pizarra WS:** el servicio solo lee `?token=`. Con `PIZARRA_WS_TOKEN_QUERY=on` el gateway toma el JWT de
  `Authorization: Bearer` (clientes sin cookie) o de la cookie `cb_session` (web) y lo añade **solo hacia el upstream**; el cliente
  nunca pone el token en la URL. Se apaga con `off` cuando Pizarra lea cabecera/cookie.

## Alternativas
- *Traefik/Kong/YARP:* más piezas y plugins sin ganancia para un enrutamiento estático; el equipo y los docs ya asumen Nginx.
- *Rutas fijas en `nginx.conf` sin plantillas:* obligaría a editar y reconstruir el gateway cada vez que otro paquete
  fije su puerto o ruta.
- *Cambiar las rutas internas de Pizarra para que coincidan:* toca código de otros; se prefirió reescribir en el borde.

## Consecuencias
- (+) Cambios de ruta/puerto sin recompilar el gateway; contrato verificable con un upstream de eco.
- (−) Las plantillas envsubst exigen escapar/comillar regex con `{n,m}` (Nginx las interpreta como bloques sin comillas).
- (−) La traducción cookie/Bearer → `?token=` es deuda temporal (ver `docs/p2-pendientes-coordinacion.md`).
