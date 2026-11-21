# ADR 0020 — Notificaciones: Queue-Based Load Leveling y Competing Consumers

**Estado:** Evidencia cuantitativa exploratoria documentada · **Responsable:** Cristian García

## Contexto

El módulo C# consume eventos de RabbitMQ con `BasicQos(0, 1, false)` y confirmación ACK después de escribir en `notification-db`. El productor persiste eventos en una outbox que un despachador publica en lotes de 25 con un ciclo de 500 ms. El reparto del P3 solicita medir desacople productor-consumidor y escalamiento con 1, 2 y 4 workers.

## Decisión provisional

Conservar el sistema asíncrono con RabbitMQ y competir por una misma cola (`Competing Consumers`). Parametrizar `WORKER_PREFETCH` y un retraso artificial exclusivo del laboratorio (`WORKER_TEST_DELAY_MS`). Evaluar workers 1/2/4, prefetch 1/20 y ráfagas 500/2000/5000 **con los mismos límites, siembra y mezcla por configuración**.

## Alternativas

- Invocar a la base de notificaciones de forma síncrona desde el productor: aumenta acoplamiento de latencia.
- Aumentar solo prefetch sin consumidores adicionales: no garantiza throughput si el procesamiento local es secuencial.
- Más workers: consume más memoria/conexiones y puede trasladar saturación a PostgreSQL.

## Consecuencias, criterios y decisión final pendiente

Se deben registrar `p50/p95/p99`, eventos/s, tiempos de drenaje, profundidad de cola, CPU/RAM, errores y eventos en DLQ. La integridad esperada es que no haya eventos perdidos ni notificaciones duplicadas. Elegir configuración a partir de evidencia real; no se declara una mejora hasta ejecutar la variante y contrastarla.

**Pendiente para robustecer:** medianas/rangos de 3 repeticiones, gráficas superpuestas y confirmación instrumental del cuello de botella. **Nota:** confirmar con el equipo la reserva del número ADR 0020.

## Evidencia del piloto S4

Se ejecutaron siete ráfagas de 500 eventos con 25 VUs, prefetch 1 y 1/2/4 consumidores, con retrasos de 0/200 ms. Todos los eventos fueron aceptados por HTTP 202. Con retraso de 200 ms se observó acumulación temporal en RabbitMQ y posteriormente la cola se vació sin mensajes en DLQ.

Los resultados detallados se encuentran en `rendimiento/notificaciones/results/resumen.csv`. La decisión final de capacidad sigue pendiente de repeticiones, tiempos de drenaje, utilización de recursos e integridad.

## Cierre experimental P3 — 21 de noviembre de 2026

**Estado:** decisión sustentada por evidencia exploratoria, aún sin tres repeticiones formales. Informe y tablas: [`rendimiento/notificaciones/INFORME_P3_SATURACION.md`](../../rendimiento/notificaciones/INFORME_P3_SATURACION.md).

Con ocho workers, prefetch 1 y demora sintética de 200 ms, el p95 de entrega fue 732,16 ms a 20 eventos/s, 1150,52 ms a 25, 2772,59 ms a 30 y 4904,31 ms a 40. El objetivo de entrega p95 < 1000 ms fue exploratorio y añadido durante el estudio. A 40 eventos/s se observó backlog creciente hasta 191 eventos en una corrida, y una segunda corrida con 2400/2400 notificaciones entregadas mostró variabilidad; no se afirma un techo de throughput exacto.

A 50 eventos/s se registraron 7/3000 fallas HTTP, p95 HTTP ~1420 ms y un rechazo de conexión PostgreSQL (`too many clients already`, máximo configurado 100). Un evento publicado alcanzó la DLQ con `x-death.reason=delivery_limit`. La recuperación **manual** por reactivación controlada de la outbox consiguió 2993/2993 eventos aceptados persistidos y cero duplicados. La copia en DLQ permanece como evidencia histórica hasta una limpieza controlada. El incidente no demuestra por sí mismo fuga de conexiones.

**Decisión:** mantener Queue-Based Load Leveling, Competing Consumers, outbox transaccional, ACK tras commit, idempotencia por `(event_id, recipient_id)` y DLQ. Ocho workers, prefetch 1, delay 200 ms no son una elección productiva universal, sino la variante del experimento. Pendiente para una decisión de despliegue: 3 repeticiones, saturación sin demora artificial, contraste prefetch 1/20 e instrumentación de conexiones durante el test.
