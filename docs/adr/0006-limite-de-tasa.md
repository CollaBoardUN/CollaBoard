# ADR 0006 · Límite de tasa en el gateway

- **Estado:** aceptada · **Fecha:** 2026-10-28 · **Paquete:** F

## Contexto
El plan pide «controlar límites básicos» en el gateway. Debe proteger el login de fuerza bruta sin romper el dibujo
en tiempo real ni el sondeo de la bandeja/chat.

## Decisión
`limit_req` por IP (`$binary_remote_addr`), parametrizable:
- Zona **`auth`**: `/api/auth/*` → `5r/s`, `burst=10` (`RATE_LIMIT_AUTH`, `RATE_LIMIT_AUTH_BURST`).
- Zona **`api`**: demás rutas REST → `30r/s`, `burst=60` (`RATE_LIMIT_API`, `RATE_LIMIT_API_BURST`).
- Exceso → `429` JSON (`{"detail": "Demasiadas solicitudes…"}`) con `Retry-After: 1`.
- **WebSocket:** `limit_req` solo cuenta el *handshake*; una conexión ya establecida no se ve afectada (no hay límite por mensaje).
- El servidor interno (SSR → gateway) y `/healthz` **no** se limitan.
- Los upstream caídos devuelven `502` JSON (`Servicio temporalmente no disponible`), no una página HTML de Nginx.

Medido: 25 logins seguidos → 13×`400` (llegan a Auth) y 12×`429`; las demás rutas no se ven afectadas (test de contrato con `1r/s`).

## Alternativas
- *Sin límite:* sin defensa básica contra fuerza bruta.
- *`limit_conn`/por usuario:* requeriría decodificar el JWT en el gateway (lógica de negocio), explícitamente descartada.

## Consecuencias
- (+) Defensa básica barata y configurable. (−) Por IP: usuarios tras un NAT comparten cuota (por eso las cifras de `api` son holgadas);
  detrás de otro proxy habría que usar `X-Forwarded-For` real (`real_ip`).
