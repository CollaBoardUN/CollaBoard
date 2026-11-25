## S4 — Sesión con JWT corto, refresh rotatorio y revocación

### 1. Escenario de seguridad

| Parte | Contenido |
|---|---|
| Fuente | Atacante con access o refresh token robado (XSS, log, cookie copiada). |
| Estímulo | Reutiliza un refresh token previamente consumido o un JWT obtenido antes del logout. |
| Artefacto | `auth-api`, BFF `web-ssr` y tabla `auth.refresh_tokens` de `user-db`. |
| Entorno | Operación normal, otras APIs verifican HS256 localmente. |
| Respuesta | Access JWT de hasta 15 min; refresh opaco de un solo uso; rotación persistente; revocación de la familia al reutilizar; logout servidor. |
| Medida | TTL máximo del access ≤ 900 s; refresh usado → HTTP 401; siguiente refresh de la familia → HTTP 401; después de logout → HTTP 401 para refresh. |

### 2. Problema arquitectónico en el P2

En el commit P2 `6af0456`, el JWT tenía un TTL de 3600 segundos.
El BFF únicamente eliminaba la cookie de sesión al cerrar sesión;
el servicio de autenticación no disponía de `/auth/logout` ni
`/auth/refresh`.

Se reprodujo el comportamiento usando los handlers HTTP originales
del P2 y un repositorio simulado de usuarios:

- JWT emitido con TTL = 3600 segundos.
- No se entrega refresh token.
- El token permite acceder a `/auth/me` antes del logout (HTTP 200).
- `/auth/logout` responde HTTP 404.
- El mismo JWT sigue funcionando después del intento de logout
  (HTTP 200).

**Evidencia:** `docs/p3/evidencia/S4/prueba-ejecucion-p2.txt`.
Script: `security-tests/s4_p2_handlers.sh`.

La prueba usa los handlers originales del P2, no el sistema
completo desplegado.

### 3. Tácticas aplicadas

- **Resist / Authenticate actors:** JWT HS256 con claims conservados e identificador `jti`.
- **Resist / Limit exposure:** access JWT configurado con vida de 15 minutos, o menos para pruebas.
- **React / Revoke access:** refresh rotatorio persistente; si un refresh usado reaparece, se invalida la familia en PostgreSQL.

### 4. Patrón aplicado

**Token-based Authentication / Security Session.** Contexto: múltiples APIs verifican el JWT localmente. Problema: sin revocación de sesión en servidor. Solución: credencial corta para operaciones y refresh opaco de un solo uso bajo control de `auth-api`; `web-ssr` administra las cookies. Archivos: `internal/security/token.go`, `internal/security/refresh.go`, `internal/httpapi/api.go`, `web-ssr/src/server/session.ts`, `web-ssr/src/app/session/{refresh,logout}/route.ts` y la migración SQL `00002_create_refresh_tokens.sql`.

**Trade-offs:** mayor complejidad de sesión y acceso a BD para refresh; el access JWT robado no se invalida de forma inmediata.

### 5. Decisiones y alternativas

ADR `docs/adr/0014-sesion-con-refresh-rotatorio.md`. Se descartan sesiones verificadas contra DB en cada petición (latencia/acoplamiento) y refresh sin persistencia (no detecta reutilización). Se conserva HS256 por compatibilidad con Colaboración, Pizarra y Chat.

### 6. Verificación

**Comparación P2 frente a P3:**

| Propiedad | P2 | P3 |
|---|---|---|
| TTL del access JWT | 3600 s | Máximo 900 s |
| Refresh token | No disponible | Opaco y rotatorio |
| Logout servidor | HTTP 404 | HTTP 204 |
| Reutilización de refresh | No disponible | HTTP 401 |
| Revocación de familia | No disponible | Comprobada |
| Expiración real a 5 s | No probada | HTTP 401 |

**Pruebas ejecutadas:**

1. `security-tests/s4_p2_handlers.sh`: PASS contra handlers P2.
2. `security-tests/s4_sesion.mjs`: 10/10 verificaciones correctas.
3. La misma prueba con TTL de 5 s: 11/11 verificaciones correctas.
4. `security-tests/s4_web_refresh.mjs`: 8/8 comprobaciones correctas.
5. `go test ./...`: pruebas del módulo de autenticación correctas.

La prueba web confirma la secuencia HTTP 401 → 307 → 303 → 200,
con renovación de ambos tokens mediante cookies HttpOnly.

**Archivos de evidencia:**

- `docs/p3/evidencia/S4/prueba-ejecucion-p2.txt`
- `docs/p3/evidencia/S4/prueba-seguridad-p3.txt`
- `docs/p3/evidencia/S4/expiracion-jwt-5s.txt`
- `docs/p3/evidencia/S4/renovacion-web.txt`
- `docs/p3/evidencia/S4/pruebas-unitarias-go.txt`

**Alcance y limitaciones:** la prueba P2 usa un repositorio simulado;
la prueba web simula cookies mediante HTTP, no utiliza un navegador real.
El rechazo de JWT manipulado se verificó en Auth, pero falta
comprobarlo explícitamente en las otras APIs. Los WebSocket ya
abiertos pueden requerir una política adicional de expiración.

### 7. Cambios en las vistas

- **C&C:** nuevas interfaces `/auth/refresh`, `/auth/logout`; cookies en BFF; `auth-api → user-db` para refresh; verificadores locales en otras APIs.
- **Despliegue:** anotación TTL/secreto en `auth-api`; tabla `auth.refresh_tokens` en `user-db`; no hay nuevos contenedores ni redes por S4.
- **Capas:** `Security Session` en Presentación (`web-ssr`) y `Refresh Token Service / Revocación` en Lógica (`auth-api`).
- **Descomposición:** subsistema Identidad > `auth-api` > `Refresh y sesión`, `Revocación`.
- **Secuencia:** login → uso → refresh → reutilización → revocación familiar → logout.

### 8. Rendimiento

Ensayo de notificaciones asíncronas. Hipótesis: aumentar workers de 1 a 2/4 incrementa throughput hasta que la outbox, el broker o PostgreSQL sature; añadir 200 ms al procesamiento aumenta el backlog pero **no debería** aumentar proporcionalmente el p95 del API productor. Patrones: Queue-Based Load Leveling, Competing Consumers. Banco de pruebas: `rendimiento/notificaciones`. Los resultados medidos y la evaluación de integridad están disponibles en el informe P3 enlazado al final del documento. El estudio es exploratorio: una corrida de 60 s por nivel de carga, sin campaña estadística de tres repeticiones (ver amenazas a la validez en el informe).

## Complemento experimental final P3

En P2 (commit `6af0456`) se reprodujo TTL 3600 s, ausencia de endpoints refresh/logout y JWT válido después de borrar la cookie. En P3 se ejecutaron 11/11 verificaciones de sesión (incluida expiración temporal de 5 s), ocho de renovación SSR vía peticiones HTTP/cookies simuladas y pruebas Go satisfactorias; el TTL normal de 15 min fue restaurado. Véanse `docs/p3/evidencia/S4/` y `security-tests/`. Persisten riesgos residuales de JWT vigente hasta su vencimiento y WebSocket ya abierto.

El estudio de RabbitMQ con 8 workers, prefetch 1 y 200 ms sintéticos mostró rodilla de calidad exploratoria entre 20–25 eventos/s (p95 de entrega de 732,16 ms y 1150,52 ms), backlog a 40 eventos/s y fallo/derivación a DLQ a 50. La recuperación manual culminó en 2993/2993 aceptados y persistidos sin duplicados. Detalles, método y límites en [`INFORME_P3_SATURACION.md`](../../../rendimiento/notificaciones/INFORME_P3_SATURACION.md) y ADR 0020.
