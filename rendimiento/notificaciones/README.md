# Prueba de rendimiento — Notificaciones asíncronas (Cristian García)

**Resultados finales P3:** [Informe de saturación, rodilla, fallo DLQ y recuperación](INFORME_P3_SATURACION.md).

## 1. Pregunta / hipótesis

¿La cola desacopla latencia del productor del costo de procesar notificaciones y cuántos workers aprovecha antes de saturar? Hipótesis previa: con retraso artificial de 200 ms por evento, el p95 del `POST /internal/events` debe mantenerse cercano al de la configuración sin retraso; la profundidad de la cola y el tiempo de drenaje aumentarán. Al sumar workers 1 → 2 → 4 debe mejorar mensajes procesados/s hasta alcanzar el cuello de la outbox o base de datos. **Los valores A y B se fijarán tras la línea base propia antes de la variante**, no se declaran medidos.

## 2. Táctica / patrón

Introduce concurrency, Bound queue sizes, Schedule resources. Queue-Based Load Leveling (buffer), Competing Consumers (N workers); RabbitMQ Quorum y DLQ.

## 3. Escenario de seis partes

- Fuente: productor de notificaciones en ráfagas controladas.
- Estímulo: 500/2000/5000 eventos por `POST /internal/events` en red interna y token de servicio de prueba.
- Artefacto: notification-api → outbox → rabbitmq → message-worker → notification-db.
- Entorno: stack de laboratorio con servicios/recursos acotados; BD de prueba aislada.
- Respuesta: aceptación 202 y procesado posterior por workers.
- Medida: p50/p95/p99 del POST, eventos/s, cola en el tiempo, tiempo de vaciado, DLQ, CPU/RAM, integridad.

## 4. Carga y variantes

| Dimensión | Valores |
|---|---|
| Eventos por corrida | 500, 2000, 5000 |
| VUs en k6 | 25 por defecto; justificar y escalar tras piloto |
| Workers | 1, 2, 4 |
| Prefetch | 1, 20 |
| Retraso artificial | 0, 200 ms |
| Repeticiones | 3 en los niveles clave; reportar mediana y mín–máx |

Las ráfagas se comparan con el mismo número de eventos, payload, recursos y siembra. Se debe realizar una curva escalonada con calentamiento ≥ 10 s y niveles ≥ 60 s para ubicar la rodilla; el script `burst.js` es **solo** la fase de ráfagas, no sustituye esa curva. Ejecutar k6 preferentemente desde otro equipo con red cableada y anotar su CPU; el compose incluido ejecuta k6 en el mismo host, lo que se debe declarar como limitación.

## 5. Entorno

`compose.override.yml` declara 1 CPU para API, worker, DB y RabbitMQ (valores de memoria distintos). Registrar en el informe CPU/RAM del host, Docker version, sistema, commit, red, límites y datos. Tras la integración de S3 cambiar `k6-notifications.networks` para la topología real. No ejecutar contra datos reales ni subir `.env` o credenciales.

## 6. Baseline vs variante

**Una variable por comparación:** (A) workers 1 vs 2 o 4 con prefetch=1 y delay=0; (B) prefetch=1 vs 20 con workers constantes; (C) delay=0 vs 200 con workers y prefetch constantes. No mezclar más de una modificación por corrida A/B. El worker síncrono puede no aprovechar prefetch alto; medir y explicar.

## 7. Umbrales (antes de medir)

k6 exige `http_req_failed<1%` y `p95(http_req_duration)<500ms` como umbrales iniciales de **aceptación del productor**, revisables antes de la campaña formal. Se debe fijar además un objetivo de procesamiento y tiempo de drenaje *antes* de medir las variantes. No modificar umbrales retrospectivamente.

## 8. Cómo reproducir

Desde un clon del repo con `.env` propio y Docker Compose:

```bash
WORKERS=1 WORKER_PREFETCH=1 WORKER_TEST_DELAY_MS=0 EVENTS=500 VUS=25 bash rendimiento/notificaciones/run.sh
WORKERS=2 WORKER_PREFETCH=1 WORKER_TEST_DELAY_MS=0 EVENTS=500 VUS=25 bash rendimiento/notificaciones/run.sh
WORKERS=4 WORKER_PREFETCH=1 WORKER_TEST_DELAY_MS=0 EVENTS=500 VUS=25 bash rendimiento/notificaciones/run.sh
# Contraste de desacople
WORKERS=1 WORKER_PREFETCH=1 WORKER_TEST_DELAY_MS=200 EVENTS=500 VUS=25 bash rendimiento/notificaciones/run.sh
```

En otra terminal, ejecutar `python rendimiento/notificaciones/capturar-stats.py` antes de la carga. Después generar curvas con `python rendimiento/notificaciones/graficar.py` (requiere matplotlib).

Resultados JSON se guardan en `rendimiento/notificaciones/results/`. Entre corridas, esperar cola vacía e instrumentar `docker stats --no-stream` con marca de tiempo cada 2 segundos. Para medir profundidad, usar la API de gestión RabbitMQ con credenciales de admin *solo en local*, consultar `/api/queues/<vhost>/<queue>` y guardar `messages_ready`, `messages_unacknowledged`, `message_stats.*` cada 2 segundos. Comparar eventos emitidos con entradas de `notification_events` y con `notifications` (por destinatario), contando DLQ y duplicados; no equiparar número de mensajes con filas de bandeja si hay varios destinatarios.

**Nota:** el productor usa una outbox con despacho periódico de hasta 25 eventos por lote; medir sus pendientes junto con la cola. Sin comprobar ese componente no atribuir un techo a RabbitMQ.

## 9. Resultados

### Piloto de ráfagas

Se ejecutaron siete corridas con 500 eventos, 25 VUs y prefetch 1. Se compararon 1, 2 y 4 workers con retrasos de 0 y 200 ms.

| Workers | Retraso (ms) | p95 HTTP (ms) | Solicitudes/s | Errores HTTP |
|---:|---:|---:|---:|---:|
| 1 | 0 | 823.48 | 236.85 | 0% |
| 2 | 0 | 89.62 | 536.36 | 0% |
| 4 | 0 | 115.22 | 400.91 | 0% |
| 2 | 0 | 117.87 | 420.33 | 0% |
| 1 | 200 | 210.48 | 388.42 | 0% |
| 2 | 200 | 124.06 | 397.3 | 0% |
| 4 | 200 | 91.92 | 634.86 | 0% |

Todas las solicitudes recibieron HTTP 202. La configuración de 1 worker y 0 ms obtuvo p95 de 823,48 ms en la corrida conservada, superando el umbral de 500 ms.

Se observaron consumidores concurrentes y acumulación temporal de mensajes con retraso artificial. Posteriormente se verificó que RabbitMQ tenía cero mensajes pendientes, cero sin confirmar y cero mensajes en la DLQ.

**Limitaciones:** la mayoría de las configuraciones tienen una sola repetición; no se midieron formalmente tiempos de drenaje, CPU/RAM ni la integridad extremo a extremo por identificador. Las tasas reportadas corresponden a aceptación HTTP, no a procesamiento de notificaciones.

## 10. Análisis

Calcular `D=U/X` del recurso cuello, techo `1/D`, y contrastar `L=λW` y `R≈N/X−Z` cuando corresponda. Confirmar saturación con CPU, conexiones DB, backlog de outbox y RabbitMQ, no con inferencia visual sola.

## 11. Amenazas a la validez

Host compartido, CPU del generador, broker/outbox entre productor y worker, variación de base, caché caliente, colisiones de RUN_ID, diferentes números de destinatarios, limpieza de colas, monitorización insuficiente, doble uso de k6 y SUT en host único.

## 12. Conclusión / decisión

Solo tras mediciones: completar ADR `docs/adr/0020-competidores-notificaciones.md`, justificar configuración de workers/prefetch y tradeoff CPU/BD/latencia. No inventar resultados.
