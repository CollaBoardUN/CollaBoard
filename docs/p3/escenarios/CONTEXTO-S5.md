# CONTEXTO S5 · Role-Based Access Control (RBAC) + Authorizer: qué cambió y qué deben tener en cuenta

Responsable: David Eduardo Calderón · Rama: `p3/s5-rbac` · Detalle técnico completo: [`fragmentos/S5-rbac.md`](fragmentos/S5-rbac.md)

## 1. Qué cambió, en una línea

`collaboration-api` es ahora el único **Policy Decision Point (PDP)** con una tabla declarativa única `POLICY_MATRIX` (`3 roles × 24 acciones` en `colaboracion-module/app/policy.py`), y tanto `pizarra-api` como `chat-api` operan como **Policy Enforcement Points (PEPs)** estrictamente *fail-closed* con caché en memoria **Cache-Aside (`TTL = 2 s`)**, revalidación WebSocket en `≤ 3 s` y purga síncrona en `/internal/{canvas,chat}/boards/{id}`.

## 2. Lo que tienen que hacer TODOS al integrar esta rama

1. **Actualizar el `.env` con las variables de S5** (añadidas en `.env.example` y `docker-compose.yml`):
   - `INTERNAL_SERVICE_TOKEN` (compartido entre `collaboration-api`, `pizarra-api` y `chat-api`).
   - `AUTHZ_DECISION_TTL_SECONDS=2.0` (en `collaboration-api`).
   - `AUTHZ_CACHE_TTL_SECONDS=2.0`, `ROLE_RECHECK_SECONDS=2.0`, `LEGACY_BOARDS_ROUTES_ENABLED=false` (en `pizarra-api`).
   - `COLLABORATION_BASE_URL=http://collaboration-api:8000`, `CHAT_PERMISSION_CACHE_TTL_MS=2000`, `CHAT_RECHECK_MS=3000` (en `chat-api`).
2. **No usar `pizarra-api` para crear o listar tableros (`/boards`, `/invites`):** esas rutas heredadas del P1/P2 quedaron deshabilitadas en producción (`LEGACY_BOARDS_ROUTES_ENABLED=false`). Todo el CRUD de tableros, miembros e invitaciones vive exclusivamente en `collaboration-api` (`/api/boards`, `/api/invites`).

## 3. Herramientas de prueba de S5

| Herramienta | Cómo se ejecuta |
|---|---|
| Verificación completa del escenario S5 (en proceso, sin Docker, corre en `< 5 s`) | `python security-tests/s5_rbac.py --mode inprocess --evidence docs/p3/evidencia/S5/despues` |
| Verificación de S5 contra el código base P2 (reproduce los 8 fallos del P2) | `python security-tests/s5_rbac.py --mode inprocess --target-root "../Codigo Base/CollaBoard-main" --evidence docs/p3/evidencia/S5/antes` |
| Verificación de S5 por HTTP contra el stack Docker levantado | `python security-tests/s5_rbac.py --mode http --base http://localhost:8088` (o `https://localhost:8443` tras S1) |
| Unit tests de política RBAC y PDP (`collaboration-api`) | `cd colaboracion-module && pytest -q` |
| Unit tests de PEP + Cache-Aside (`pizarra-api`) | `cd pizarra-module/pizarra-backend && pytest -q` |
| Unit tests del contrato de chat (`chat-api`) | `cd chat-module && mvn test` |
| Banco de rendimiento RBAC (`k6`, reproducible) | Ver [`rendimiento/rbac/GUIA_EJECUCION_COMPANERO.md`](../../rendimiento/rbac/GUIA_EJECUCION_COMPANERO.md) y `sh rendimiento/rbac/run.sh collaboard` |

## 4. Por escenario: lo que toca a cada quien

| Escenario | Qué deben saber de S5 |
|---|---|
| **S1 · Secure Channel (TLS)** | `security-tests/s5_rbac.py` soporta `--base https://localhost:8443` en modo HTTP y `--mode inprocess` en el CI. Los cambios internos entre `pizarra-api`/`chat-api` y `collaboration-api` van por la red interna HTTP con `X-Service-Token`. |
| **S2 · Reverse Proxy** | El gateway **no** debe interceptar `/internal/*` para tráfico público (solo `/api/boards`, `/api/invites`, `/api/canvas`, `/api/chat`, `/ws/*`). |
| **S3 · Network Segmentation** | `pizarra-api` y `chat-api` **necesitan alcanzar a `collaboration-api:8000`** por la red interna de aplicación para consultar `GET /internal/boards/{id}/access` y `GET /internal/boards/{id}/recipients`, y `collaboration-api` necesita alcanzar a `pizarra-api:8000` (`DELETE /internal/canvas/boards/{id}`) y a `chat-api:8083` (`DELETE /internal/chat/boards/{id}`). Ni `pizarra-api` ni `chat-api` deben tener acceso de red a `board-db`. |
| **S4 · Gestión de sesión JWT** | El PDP (`GET /internal/boards/{id}/access`) acepta el JWT tanto por `Authorization: Bearer` como por la cookie `cb_session`, y los PEPs (`pizarra-api` y `chat-api`) reenvían el token recibido al PDP e indexan su caché `Cache-Aside` usando `sha256(token)`. Si S4 rota o revoca el token de acceso, la clave en la caché del PEP cambia automáticamente. |

## 5. Diagramas entregados en esta rama

- **Línea base asignada en el reparto:** `docs/p3/diagramas/base/vista-descomposicion.base.drawio` (y se incluye `base/vista-cc.base.drawio`).
- **Cuatro vistas arquitectónicas con S5 en rojo (`#D62828`):**
  - `docs/p3/diagramas/vista-cc.S5.{drawio,png}`
  - `docs/p3/diagramas/vista-despliegue.S5.{drawio,png}`
  - `docs/p3/diagramas/vista-capas.S5.{drawio,png}`
  - `docs/p3/diagramas/vista-descomposicion.S5.{drawio,png}`
- **Diagrama de secuencia de S5:** `docs/p3/diagramas/secuencia-s5.{drawio,png}`.
- **Bitácora de cambios para integrar las vistas:** `docs/p3/diagramas/CAMBIOS-S5.md`.

## 6. Dónde está cada cosa

| Ruta | Qué es |
|---|---|
| `colaboracion-module/app/policy.py` | Tabla declarativa única `POLICY_MATRIX` (`3 roles × 24 acciones`) y helpers del PDP |
| `colaboracion-module/app/permissions.py`, `app/routers/internal.py`, `app/routers/boards.py`, `app/routers/invites.py` | PEP local (`require_action`) y endpoints internos del PDP (`/internal/policy`, `/internal/boards/{id}/access?action=...`) |
| `pizarra-module/pizarra-backend/app/internal_client.py`, `app/routers/ws.py`, `app/routers/internal_canvas.py`, `app/main.py` | PEP *fail-closed* con `Cache-Aside` (`TTL = 2 s`), revalidación WS en `ops`/`draft`/tick y desactivación de rutas duplicadas |
| `chat-module/src/main/java/com/collaboard/chat/security/CollaborationClient.java`, `controller/InternalChatController.java`, `websocket/ChatSocketHandler.java` | PEP en Java con `X-Service-Token`, caché en `ConcurrentHashMap` (`TTL = 2 s`), `recheck-ms = 3000` y `DELETE /internal/chat/boards/{id}` |
| `docs/p3/politica-rbac.md` | Especificación de la matriz `rol × acción` y reglas de códigos HTTP (`401` / `404` / `403` / `200`) |
| `docs/adr/0015-rbac-authorizer-pdp-pep.md` | ADR 0015 del escenario S5 |
| `security-tests/s5_rbac.py` | Verificador automático de las 11 comprobaciones, las 144 celdas de la matriz, la revocación WS en vivo y el hit-ratio de la caché |
| `docs/p3/evidencia/S5/{antes,despues}/` | Salidas, resúmenes JSON, matrices Markdown de 144 celdas y gráfica comparativa `s5-captura-antes-despues.png` |
| `rendimiento/rbac/` | Ficha experimental (`README.md`), guía paso a paso para el compañero (`GUIA_EJECUCION_COMPANERO.md`), `compose.override.yml`, `k6/rbac_cache.js` y `run.sh` |
| `docs/p3/fragmentos/S5-rbac.md` | Fragmento listo de 8 secciones para el informe PDF final |

## 7. Resultados en una tabla

| Medida | P2 (`Codigo Base/CollaBoard-main`) | P3 (`CollaBoard-p3-s5`) |
|---|---|---|
| `security-tests/s5_rbac.py` | 8 FAIL | **11/11 OK** |
| Matriz RBAC (`6 identidades × 24 operaciones`) | Sin tabla declarativa; CRUD duplicado y fallback `owner` en pizarra; contrato roto en chat | **144/144 celdas OK** |
| Degradación en caliente (`editor → viewer`) en WebSocket activo | `draft` no revalidaba rol en pizarra | **`0,669 s`** (cota: `≤ 5,0 s`) |
| Expulsión en caliente (`DELETE member`) en WebSocket activo | `60 s` en chat | **`0,559 s`**, cierre `4403` (cota: `≤ 5,0 s`) |
| Llamadas al PDP en ráfaga de 20 operaciones dentro del TTL | `20 / 20` (`0 %` ahorro) | **`1 / 20` (`-95,0 %` llamadas al PDP)** |
