# ADR 0007 · TLS descartado en el prototipo 2 (mejora futura)

- **Estado:** aceptada (descarte deliberado) · **Fecha:** 2026-10-28 · **Paquete:** F

## Contexto
Los servicios se demuestran en `localhost`/red local. Gestionar certificados (autofirmados o ACME) añade trabajo y
fricción (el navegador debe confiar en la CA) sin ser un requisito del enunciado ni del plan.

## Decisión
**No hay TLS.** El gateway escucha HTTP en `:80` (publicado como `8088`). Consecuencias asumidas y documentadas:
- La cookie de sesión de la web usa `SESSION_COOKIE_SECURE=false` (con `true` el navegador no la guardaría sobre `http://localhost`).
- Los JWT y contraseñas viajan en claro por la red local: **no exponer el gateway a redes no confiables**.
- Si algún día hay TLS, el gateway no requiere cambios de código en los clientes (solo URLs `https://`).

## Mejora futura (cuando se despliegue fuera de localhost)
1. Terminar TLS en el gateway (`listen 443 ssl`, `ssl_certificate`, redirección 80→443, HSTS).
2. `SESSION_COOKIE_SECURE=true`, `X-Forwarded-Proto` ya se propaga.
3. Certificados por ACME o una CA interna; en desarrollo, `mkcert`.
4. `PUBLIC_ORIGIN`, `CHAT_ALLOWED_ORIGINS`, `FRONTEND_URL` con `https://`.

## Consecuencias
- (+) Arranque reproducible sin certificados. (−) No apto para producción tal cual; debe constar como limitación en el informe.
