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

`authentication-module/internal/config/config.go`: `TokenTTL: time.Hour`. `authentication-module/internal/httpapi/api.go`: no existían `/auth/refresh` ni `/auth/logout`. `web-ssr/src/app/actions/session.ts` cerraba sesión borrando `cb_session` exclusivamente. Ejecutar `node s4_baseline_p2.mjs` contra el commit `6af0456` para reproducir y guardar la salida. **Falta adjuntar la salida medida del antes**.

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

- Ejecutar `node security-tests/s4_sesion.mjs` contra el stack P3 y almacenar su salida.
- Con `JWT_ACCESS_TTL=5s`, repetir con `EXPECT_TTL_5S=1` y comprobar expiración; probar navegación web más allá del TTL.
- Mostrar la misma acción en P2 y P3. **No se proporcionan números medidos ni capturas hasta ejecutar la prueba**.
- Riesgo residual: WebSocket ya abierto puede seguir activo hasta cerrar la conexión si el servicio no vigila `exp`.

### 7. Cambios en las vistas

- **C&C:** nuevas interfaces `/auth/refresh`, `/auth/logout`; cookies en BFF; `auth-api → user-db` para refresh; verificadores locales en otras APIs.
- **Despliegue:** anotación TTL/secreto en `auth-api`; tabla `auth.refresh_tokens` en `user-db`; no hay nuevos contenedores ni redes por S4.
- **Capas:** `Security Session` en Presentación (`web-ssr`) y `Refresh Token Service / Revocación` en Lógica (`auth-api`).
- **Descomposición:** subsistema Identidad > `auth-api` > `Refresh y sesión`, `Revocación`.
- **Secuencia:** login → uso → refresh → reutilización → revocación familiar → logout.

### 8. Rendimiento

Ensayo de notificaciones asíncronas. Hipótesis: aumentar workers de 1 a 2/4 incrementa throughput hasta que la outbox, el broker o PostgreSQL sature; añadir 200 ms al procesamiento aumenta el backlog pero **no debería** aumentar proporcionalmente el p95 del API productor. Patrones: Queue-Based Load Leveling, Competing Consumers. Banco de pruebas: `rendimiento/notificaciones`. **Faltan resultados, curvas, ley de Little, comprobación de integridad y conclusión cuantitativa; no se inventan cifras**.
