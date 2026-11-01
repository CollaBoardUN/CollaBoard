# ADR 0002 · Ruta interna SSR → gateway distinta de la página

- **Estado:** aceptada · **Fecha:** 2026-10-28 · **Paquete:** F

## Contexto
La web SSR (Next.js) consulta las APIs durante el renderizado (conector C02) y el navegador entra por el mismo
gateway (mismo origen). Si el SSR llamara al mismo puerto/ruta que atiende páginas, una ruta no resuelta caería de
nuevo en `location /` → web-ssr, generando **bucles** gateway ⇄ web.

## Decisión
El gateway define **dos `server`** que comparten el mismo archivo de rutas de API (`api-routes.conf`):
- `:80` (publicado al host como `:8088`): API + `location /` → web-ssr.
- `:${GATEWAY_INTERNAL_PORT}` (8081): **solo API**; `location /` devuelve 404 JSON. No se publica al host y solo es
  alcanzable desde la red `internal`. `web-ssr` usa `GATEWAY_INTERNAL_URL=http://gateway:8081`.
- El servidor interno no aplica `limit_req`: todas las peticiones del SSR salen de una IP (limitarlas por IP castigaría a todos los usuarios).

## Alternativas
- *Un solo `server` con cabecera secreta:* más fácil de mal configurar y de filtrar por el borde.
- *SSR → servicios directos:* rompe «un único gateway» (C02 debe pasar por el gateway) y duplica el enrutamiento.

## Consecuencias
- (+) Sin bucles; el ingreso público no expone el puerto interno (verificado: `localhost:8081` no responde; el SSR sí alcanza `gateway:8081`).
- (+) Las reglas de seguridad (`/internal/*` bloqueado) viven en un solo archivo y valen para ambos puertos.
- (−) Un puerto más que documentar y mantener fuera del host.
