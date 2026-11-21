# ADR 0014 — JWT de corta duración y sesión con refresh rotatorio

**Estado:** Propuesta para revisión y ejecución de pruebas del P3 · **Responsable:** Cristian García

## Contexto

En el P2 `authentication-module/internal/config/config.go` fijaba `TokenTTL: time.Hour`. La API emitía un JWT HS256 sin identificador `jti`, y el cierre de sesión del BFF borraba exclusivamente la cookie `cb_session`. El sistema no podía revocar en el servidor el mecanismo de renovación porque no existía. Un JWT robado seguía siendo aceptado hasta su expiración.

## Decisión

- Access JWT HS256 con la misma estructura de claims existente y un nuevo `jti` aleatorio. Vida útil por `JWT_ACCESS_TTL` (por defecto `15m`, máximo `15m`). No añadir claim `aud` ni cambiar los verificadores locales de las otras APIs.
- Refresh token opaco aleatorio de 256 bits, no un segundo JWT. Se guarda únicamente SHA-256 en `auth.refresh_tokens`, junto con usuario, familia, vencimiento, revocación, reemplazo y agente de usuario.
- En cada renovación, una transacción bloquea el refresh presentado, lo marca como usado y crea el siguiente. Reutilizar el token anterior revoca la familia completa; el siguiente refresh también deja de servir.
- `/auth/logout` revoca en PostgreSQL la familia de refresh tokens de la sesión. El BFF mantiene `cb_session` HttpOnly SameSite=Lax Path=/ y `cb_refresh` HttpOnly SameSite=Strict Path=/session; ambas deben usar Secure sobre HTTPS (coordinación S1).
- La verificación del JWT de acceso sigue siendo local y su revocación no es instantánea: un JWT robado puede seguir válido hasta 15 minutos. Los WebSocket ya abiertos deben implementar política de cierre por expiración o documentarse como limitación pendiente.

## Alternativas descartadas

1. Mantener JWT de 1 h sin renovación: no reduce ventana de abuso.
2. Invalidar cada access JWT contra base de datos: añade dependencia central a todas las solicitudes y servicios; rompe el modelo de verificación local.
3. Refresh JWT sin persistencia: no permite detección fiable de reutilización ni logout servidor.
4. RS256/EdDSA: reduce riesgo de clave compartida entre servicios, pero requiere migrar los verificadores de otras APIs. Queda como mejora futura, sin mezclarla con S4.

## Consecuencias y compromisos

- Más tablas y E/S durante login, refresh y logout, pero el tráfico ordinario de las APIs no consulta PostgreSQL para verificar el access JWT.
- Una reutilización maliciosa o dos renovaciones legítimas concurrentes del mismo refresh pueden invalidar la familia; conviene coordinar renovaciones entre pestañas (single-flight) en una iteración posterior.
- S4 no sustituye TLS, CSP, defensas XSS ni S6 (bloqueo de intentos de login). El token en memoria robado conserva validez hasta su `exp`.
- En despliegues multiinstancia, la base de datos centraliza rotación y revocación. Se debe considerar limpieza programada de tokens vencidos y límites de conexiones.

## Verificación requerida

Comandos: `node security-tests/s4_sesion.mjs` y `cd authentication-module && go test ./...` desde un clon actualizado. Se requiere guardar salida real, estado CI, captura de un refresh reutilizado (401) y comprobar renovación web con TTL de prueba `JWT_ACCESS_TTL=5s`. No se han incorporado resultados de ejecución a esta ADR.

## Resultados de verificación P3 — 21 de noviembre de 2026

Se ejecutó `security-tests/s4_sesion.mjs` con 11/11 comprobaciones correctas, incluyendo TTL temporal de 5 segundos y restauración del TTL habitual. `security-tests/s4_web_refresh.mjs` comprobó ocho flujos de renovación SSR con peticiones y cookies HTTP simuladas; las pruebas unitarias Go finalizaron correctamente. Se reprodujo el comportamiento P2 en un worktree aislado a partir del commit `6af0456`, probando TTL de 3600 s y la ausencia de los endpoints refresh/logout con handlers reales y dependencias simuladas. Evidencias: `docs/p3/evidencias/s4/`. No se realizaron pruebas end-to-end en navegador real; la política de vencimiento de WebSocket abierto permanece como riesgo residual.
