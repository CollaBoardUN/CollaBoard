# Persistencia e historial de versiones

Cerrar y reabrir un tablero conserva todo. Se puede guardar una versión, volver a una anterior y deshacer esa vuelta.

Vive en `pizarra-module/pizarra-backend/app/persistence/` y se conecta al tiempo real con dos ganchos de `manager` (en `main.py`): `loader` precarga lo guardado y `on_ops` agenda el autosave.

## Cómo funciona

| Qué | Cómo |
|---|---|
| Cargar al unirse | La primera conexión a un tablero llena la sala con lo guardado en PostgreSQL. Si la carga falla, se cierra el WebSocket con `1011` y no se edita sobre un tablero vacío |
| Autosave | Se guarda 2 s después del último cambio, y como máximo 10 s después del primero si no se deja de dibujar. No escribe si el contenido no cambió |
| Al salir la última persona | Se guarda de inmediato y se crea una versión automática |
| Al apagar el servidor | Se guarda todo lo pendiente |
| Versiones automáticas | Una cada 5 min mientras se edita (si hubo cambios). Se conservan las últimas 50 |
| Versiones manuales | Con nombre opcional. Máximo 100 por tablero; no se borran solas |
| Restaurar | Guarda antes una copia del estado actual (`kind: "restore"`, últimas 20) y reemplaza el tablero. Quienes están conectados reciben `restored` y un `sync` |
| Fecha de edición | Cada guardado actualiza `boards.updated_at` |

## Tablas (migración `0002_persistencia`)

- `board_states`: una fila por tablero con `elements` (JSONB), `seq` y `saved_at`.
- `board_versions`: una fila por versión, numerada por tablero (v1, v2…), con `kind` (`auto`, `manual`, `restore`), `name`, autor y `elements` (JSONB).

Ambas se borran con el tablero.

> `pizarra-backend` y `colaboracion-backend` comparten la base `pizarra` y cada uno ejecuta `alembic upgrade head`. Por eso la migración `0002_persistencia` está copiada en los dos módulos: deben tener el mismo historial de migraciones. Cualquier migración nueva debe agregarse a ambos.

## Endpoints

Todos exigen `Authorization: Bearer <JWT>`.

| Método y ruta | Rol | Qué hace |
|---|---|---|
| `GET /boards/{id}/state` | viewer | Estado actual (en vivo si hay sala) y `saved_at` |
| `GET /boards/{id}/versions?limit=50` | viewer | Historial, de la más nueva a la más antigua, sin elementos |
| `GET /boards/{id}/versions/{vid}` | viewer | Una versión con sus elementos |
| `POST /boards/{id}/versions` | editor | Guarda una versión manual. Cuerpo opcional `{"name": "..."}`. `409` si llegó al máximo |
| `PATCH /boards/{id}/versions/{vid}` | editor | Renombra (`{"name": null}` quita el nombre) |
| `POST /boards/{id}/versions/{vid}/restore` | editor | Restaura. Responde `{restored, backup, seq}` |
| `DELETE /boards/{id}/versions/{vid}` | owner | Borra una versión |

`backup` es la copia del estado anterior a restaurar. Si ese estado ya era idéntico a la última versión no se duplica y se devuelve esa versión. Solo es `null` si el tablero estaba vacío y no había versiones.

## Mensajes nuevos del WebSocket

```json
{ "type": "saved", "seq": 12, "saved_at": "2026-10-12T15:30:00+00:00" }
{ "type": "save_error", "message": "No se pudo guardar. Reintentando…" }
{ "type": "restored", "version": { "id": "…", "number": 3, "name": null }, "by": "Ana" }
```

- `saved`: el tablero quedó guardado hasta ese `seq`. Sirve para el indicador "Guardado".
- `save_error`: falló el guardado; el servidor reintenta solo cada 5 s.
- `restored`: alguien restauró una versión. Justo después llega un `sync` con el tablero completo.

El cliente actual ignora los tipos que no conoce, así que no se rompe.

## Ajustes (variables de entorno, opcionales)

| Variable | Defecto | Qué controla |
|---|---|---|
| `AUTOSAVE_DEBOUNCE_SECONDS` | `2` | Espera tras el último cambio |
| `AUTOSAVE_MAX_WAIT_SECONDS` | `10` | Tope de espera si se sigue dibujando |
| `AUTOSAVE_SNAPSHOT_EVERY_SECONDS` | `300` | Mínimo entre dos versiones automáticas |

## Cómo probarlo

```bash
cd pizarra-module/pizarra-backend
pytest tests/test_persistence.py tests/test_autosave.py tests/test_versions.py
```

Prueba manual: dibujar en un tablero, cerrar la pestaña, `docker compose restart pizarra-backend` y volver a abrirlo. El dibujo sigue ahí.

## Limitaciones

- Un solo proceso (igual que las salas): con varios workers cada uno tendría su propio estado.
- Cada guardado y cada versión es una copia completa del tablero, no solo de los cambios. Por eso hay topes por tablero.
- Si el servidor se cae de golpe, se pueden perder los últimos segundos (hasta el debounce). En un apagado normal se guarda todo.
