# Informe P3 — S4 y rendimiento de notificaciones (Cristian García)

**Fecha de pruebas:** 21 de noviembre de 2026. **Estado:** evidencia experimental disponible; no se completó campaña estadística de tres repeticiones. **Ámbito:** responsabilidades S4 de sesión JWT y rendimiento del módulo de notificaciones. No cubre otros escenarios del equipo.

## Seguridad S4: cambio P2 → P3

- **P2 (commit `6af0456`):** `TokenTTL: time.Hour` (3600 s); no existían `/auth/refresh` ni `/auth/logout`. Borrar la cookie en el BFF no revocaba un JWT previamente emitido. La prueba aislada reprodujo HTTP 404 en el endpoint de logout y reutilización válida del token original.
- **P3:** access JWT HS256 con TTL máximo de 15 minutos; refresh opaco y rotatorio persistido por hash; revocación de la familia de refresh tras reutilización; logout con invalidación servidor; manejo SSR de cookies y renovación.
- **Verificación ejecutada:** `security-tests/s4_sesion.mjs`: 11/11 comprobaciones; TTL temporal de 5 segundos para comprobar expiración y restaurado a 15 min; `security-tests/s4_web_refresh.mjs`: 8 verificaciones correctas para expiración, 401, redirección a `/session/refresh`, rotación y recuperación SSR; pruebas unitarias Go del módulo de autenticación correctas; baseline P2 comprobada con handlers reales y repositorio simulado.
- **Límites:** renovación SSR comprobada mediante peticiones HTTP/cookies simuladas, no mediante navegador real; la expiración de sesiones WebSocket ya abiertas requiere política aparte; no se demuestra revocación inmediata de un access JWT aún vigente.
- **Evidencias locales previstas:** `docs/p3/evidencias/s4/` y scripts `security-tests/s4_*`; ADR 0014 y `docs/p3/fragmentos/S4-sesion-jwt.md`.

## Rendimiento: método y configuración

Camino: HTTP `notification-api` → PostgreSQL `notification_events`/`notification_outbox` → despachador → RabbitMQ quorum `notifications.tasks` → `message-worker` → PostgreSQL `notifications`. Los ACK ocurren después del commit y hay restricción `UNIQUE(event_id,recipient_id)`. Las corridas de saturación usaron 8 workers, `WORKER_PREFETCH=1`, `WORKER_TEST_DELAY_MS=200`, carga constante de 60 segundos, generador k6 en el mismo host y un destinatario por evento. Se muestreó el backlog total como `eventos aceptados - notificaciones persistidas`, más RabbitMQ, outbox y recursos. Las latencias de entrega son `notifications.created_at - notification_events.received_at`.

### Ráfagas controladas (500 eventos por prueba, delay=200 ms)

| Workers | Tiempo hasta drenaje (s) | Tasa efectiva aproximada (eventos/s) | Máximo RabbitMQ ready muestreado | HTTP p95 (ms) |
|---:|---:|---:|---:|---:|
| 1 | 118,88 | 4,21 | 433 | 243,46 |
| 2 | 67,66 | 7,39 | 376 | 104,65 |
| 4 | 40,30 | 12,41 | 271 | 111,28 |
| 6 | 32,04 | 15,61 | 157 | 774,70 |
| 8 | 25,84 | 19,35 | 61 | 75,60 |

Los 500 eventos por corrida fueron aceptados, publicados y persistidos, sin DLQ en esas corridas. La tasa efectiva usa el tiempo desde inicio del generador hasta confirmar el drenaje; **no** debe interpretarse como throughput máximo instantáneo. La corrida de 6 workers incumplió el umbral HTTP p95 < 500 ms pese a entregar los eventos.

### Escalera de carga constante (8 workers, 200 ms, 60 s)

| Carga ofrecida (eventos/s) | HTTP p95 (ms) | Entrega p50 (ms) | Entrega p95 (ms) | Entrega p99 (ms) | Pico backlog | Pico RabbitMQ ready | Resultado |
|---:|---:|---:|---:|---:|---:|---:|---|
| 10 | 4,41 | — | — | — | — | 0 | 601/601 persistidos; monitor previo con criterio erróneo 600 exactos |
| 20 | 3,66 | 523,15 | 732,16 | 971,88 | 27 | 2 | 1200/1200 persistidos |
| 25 | 106,07 | 594,41 | 1150,52 | 1599,28 | 32 | 13 | 1501/1501 persistidos |
| 30 | 596,34 | 1068,59 | 2772,59 | 3426,96 | 108 | 35 | 1801/1801 persistidos; incumple p95 HTTP |
| 40 (primera) | 429,48 | 4220,31 | 4904,31 | 5074,35 | 191 | 159 | 2401/2401 persistidos; backlog creciente |
| 50 | 1420 aprox. | 13414,91* | 18359,56* | 19853,69* | — | — | 7 HTTP fallidas/3000, monitor sin completar, DB rechazó conexión |
| 40 (repetición) | 3,94 | — | — | — | 111 | 93 | 2400/2400 persistidos; monitor marcó error por DLQ preexistente |

*Los percentiles de entrega de 50 eventos/s se calcularon sobre 2497 notificaciones persistidas en el momento de la consulta, **no** sobre el conjunto final recuperado. No atribuirlos a la totalidad de eventos aceptados. k6 generó en ocasiones un evento adicional al número programado de RATE × 60 por los límites temporales del generador. El segundo ensayo de 40 eventos/s muestra variabilidad entre corridas; se requieren repeticiones para estimar incertidumbre.

**Backlog a 40 eventos/s (primera corrida):** 88 a ~11 s; 159 a ~19,5 s; 162 a ~30 s; 176 a ~40,5 s; 178 a ~49 s; 191 a ~59,5 s. La aceptación promedió ~39,9 eventos/s en el tramo final, y la entrega ~38,9 eventos/s en el mismo intervalo. La cola se drenó tras cesar la carga. Esta acumulación evidencia proximidad a capacidad insuficiente para sostener indefinidamente 40 eventos/s en esa corrida; no demuestra por sí sola un límite exacto.

## Fallo y recuperación a 50 eventos/s

- 3000 solicitudes HTTP; siete fallidas (0,23 %, bajo el umbral de errores < 1 %) y HTTP p95 ~1,42 s (> 500 ms). El monitor recibió `FATAL: sorry, too many clients already`; `SHOW max_connections` devolvió 100. Una consulta posterior mostró 80 conexiones (79 idle) y otra, después de recuperación y cese de carga, tres. No se identificó en vivo qué cliente agotó el pool, por lo que **no se afirma una fuga de conexiones ni una causa raíz única**.
- De 2993 eventos aceptados, 2993 figuraron como publicados en la outbox; 2992 como notificaciones, quedando uno sin entrega. El evento `s4sat-w8-r50-1795281948-3209-141-14` estaba en `notifications.tasks.dlq` con `x-death.reason=delivery_limit`, tras fallos repetidos de procesamiento. La inspección con `ack_requeue_true` confirmó la identidad del mensaje y lo dejó en la DLQ.
- Se reactivó **manualmente y de manera condicionada** la publicación de ese único `event_id` (`published_at=NULL` únicamente si faltaba notificación), recuperándolo por el despachador. Consulta posterior: **2993 aceptados = 2993 notificaciones persistidas**, outbox pendiente 0, **2993 eventos distintos y 0 duplicados** evento-destinatario. La copia histórica en la DLQ puede seguir presente y no debe confundirse con un segundo evento perdido.
- El monitor de repetición de 40 eventos/s reportó estado 2 por detectar una DLQ global con 1 mensaje, aunque sus **2400/2400 eventos propios** fueron entregados. No atribuir el mensaje histórico a esa corrida. El muestreo de conexiones realizado aparte finalizó antes de comenzar esa repetición, por lo que no mide conexiones durante esa carga.

## Evaluación y decisión arquitectónica

- **Patrones:** Queue-Based Load Leveling, Competing Consumers, Transactional Outbox y consumidor idempotente con confirmación posterior al commit. La DLQ aísla mensajes que exceden el límite de reentregas; la recuperación evidenciada fue manual, no automática.
- **Objetivo HTTP** preexistente: p95 < 500 ms y tasa de errores < 1 %. **Objetivo de entrega p95 < 1000 ms:** criterio exploratorio incorporado durante el análisis, no umbral originalmente pre-registrado. Con este criterio se cumple en la muestra de 20 ev/s y se incumple en 25 ev/s; no afirmar una rodilla exacta ni un intervalo de confianza sin tres repeticiones.
- **Rodilla candidata de calidad:** 20–25 ev/s para la configuración de laboratorio descrita; la carga a 40 ev/s mostró acumulación sostenida y a 50 ev/s, fallo de conexiones y derivación a DLQ. La variación HTTP p95 entre las dos corridas a 40 ev/s exige cautela.
- **Decisión:** conservar el desacople asíncrono, ACK posterior a commit, unicidad por evento/destinatario y DLQ. Tratar 8 workers/prefetch 1/delay 200 ms como configuración **experimental**, no recomendación productiva. No se midió formalmente el contraste prefetch 1 vs 20 ni el techo sin retraso artificial; quedan como trabajo futuro.
- **Amenazas a validez:** generador k6 y SUT comparten host; límites CPU/memoria de Docker; muestras no atómicas; pruebas de 60 s y pocas repeticiones; tiempos de drenaje incluyen arranque/observación; DB puede retener conexiones de pool; monitoreo puede fallar bajo carga; presencia de DLQ histórica; retraso sintético no representa trabajo productivo.

## Reproducibilidad y evidencia

Scripts: `rendimiento/notificaciones/k6/burst.js`, `k6/tasa.js`, `correr-medicion.sh`, `correr-saturacion.sh`, `medir-cola.py`, `medir-saturacion.py`; datos por `RUN_ID` en `rendimiento/notificaciones/results/` (CSV de cola/recursos, JSON de k6 y archivos meta). Los logs extensos pueden mantenerse fuera de Git para evitar ruido/filtración; los CSV, resúmenes y evidencia de la DLQ son suficientes para revisar las cifras. El directorio de evidencias S4 incluye baseline P2, pruebas P3 y expiración JWT.
