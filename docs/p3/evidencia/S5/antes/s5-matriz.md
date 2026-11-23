# Matriz ejecutada del Escenario S5 · RBAC (`CollaBoard-main`)

- **Celdas verificadas:** `144/144` (100.0 %)
- **Degradación en vivo (`editor -> viewer` en WS):** `0.337 s` (umbral <= 5,0 s)
- **Expulsión en vivo (cierre `4403` en WS):** `0.562 s` (umbral <= 5,0 s)
- **Llamadas al PDP por 20 operaciones seguidas:** sin caché `20` vs con caché `20` (`-0.0 %`)

| # | Acción RBAC | Servicio (PEP) | Operación | `owner` | `editor` | `viewer` | `no_miembro` | `expulsado` | `anonimo/exp` | Estado |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `board:view` | `collaboration-api` | `GET /api/boards/{id}` | `200` | `200` | `200` | `404` | `404` | `401` | OK |
| 2 | `board:rename` | `collaboration-api` | `PATCH /api/boards/{id}` | `200` | `403` | `403` | `404` | `404` | `401` | OK |
| 3 | `member:list` | `collaboration-api` | `GET /api/boards/{id}/members` | `200` | `200` | `200` | `404` | `404` | `401` | OK |
| 4 | `member:manage` | `collaboration-api` | `PATCH /api/boards/{id}/members/{uid}` | `200` | `403` | `403` | `404` | `404` | `401` | OK |
| 5 | `member:manage` | `collaboration-api` | `DELETE /api/boards/{id}/members/{otro}` | `204` | `403` | `403` | `404` | `404` | `401` | OK |
| 6 | `invite:create` | `collaboration-api` | `POST /api/boards/{id}/invite` | `201` | `403` | `403` | `404` | `404` | `401` | OK |
| 7 | `invite:list` | `collaboration-api` | `GET /api/boards/{id}/invites` | `200` | `403` | `403` | `404` | `404` | `401` | OK |
| 8 | `invite:revoke` | `collaboration-api` | `DELETE /api/boards/{id}/invites/{iid}` | `204` | `403` | `403` | `404` | `404` | `401` | OK |
| 9 | `board:delete` | `collaboration-api` | `DELETE /api/boards/{id}` | `204` | `403` | `403` | `404` | `404` | `401` | OK |
| 10 | `canvas:view` | `pizarra-api` | `GET /api/canvas/boards/{id}/state` | `200` | `200` | `200` | `404` | `404` | `401` | OK |
| 11 | `canvas:version:create` | `pizarra-api` | `POST /api/canvas/boards/{id}/versions` | `201` | `201` | `403` | `404` | `404` | `401` | OK |
| 12 | `canvas:version:list` | `pizarra-api` | `GET /api/canvas/boards/{id}/versions` | `200` | `200` | `200` | `404` | `404` | `401` | OK |
| 13 | `canvas:version:read` | `pizarra-api` | `GET /api/canvas/boards/{id}/versions/{vid}` | `200` | `200` | `200` | `404` | `404` | `401` | OK |
| 14 | `canvas:version:rename` | `pizarra-api` | `PATCH /api/canvas/boards/{id}/versions/{vid}` | `200` | `200` | `403` | `404` | `404` | `401` | OK |
| 15 | `canvas:version:restore` | `pizarra-api` | `POST /api/canvas/boards/{id}/versions/{vid}/restore` | `200` | `200` | `403` | `404` | `404` | `401` | OK |
| 16 | `canvas:version:delete` | `pizarra-api` | `DELETE /api/canvas/boards/{id}/versions/{vid}` | `204` | `403` | `403` | `404` | `404` | `401` | OK |
| 17 | `canvas:view (WS)` | `pizarra-api` | `WS /ws/boards/{id} (handshake)` | `sync` | `sync` | `sync` | `4403` | `4403` | `4401` | OK |
| 18 | `canvas:cursor (WS)` | `pizarra-api` | `WS /ws/boards/{id} {type:cursor}` | `relay` | `relay` | `relay` | `4403` | `4403` | `4401` | OK |
| 19 | `canvas:resync (WS)` | `pizarra-api` | `WS /ws/boards/{id} {type:resync}` | `sync` | `sync` | `sync` | `4403` | `4403` | `4401` | OK |
| 20 | `canvas:draft (WS)` | `pizarra-api` | `WS /ws/boards/{id} {type:draft}` | `relay` | `relay` | `ignorado` | `4403` | `4403` | `4401` | OK |
| 21 | `canvas:edit (WS)` | `pizarra-api` | `WS /ws/boards/{id} {type:ops}` | `ack+ops` | `ack+ops` | `error:forbidden` | `4403` | `4403` | `4401` | OK |
| 22 | `chat:read` | `chat-api` | `GET /api/chat/boards/{id}/messages` | `200` | `200` | `200` | `404` | `404` | `401` | OK |
| 23 | `chat:send` | `chat-api` | `POST /api/chat/boards/{id}/messages` | `201` | `201` | `201` | `404` | `404` | `401` | OK |
| 24 | `chat:connect (WS)` | `chat-api` | `WS /ws/chat/boards/{id}` | `101` | `101` | `101` | `4403` | `4403` | `4401` | OK |
