# ADR 0020 — Notificaciones: Queue-Based Load Leveling y Competing Consumers

**Estado:** Pendiente de decisión cuantitativa · **Responsable:** Cristian García

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

**Pendiente:** completar tabla de resultados (mediana y rango de 3 repeticiones), gráficas superpuestas, cuello confirmado y recomendación. **Nota:** confirmar con el equipo la reserva del número ADR 0020.

## Evidencia del piloto S4

Se ejecutaron siete ráfagas de 500 eventos con 25 VUs, prefetch 1 y 1/2/4 consumidores, con retrasos de 0/200 ms. Todos los eventos fueron aceptados por HTTP 202. Con retraso de 200 ms se observó acumulación temporal en RabbitMQ y posteriormente la cola se vació sin mensajes en DLQ.

Los resultados detallados se encuentran en `rendimiento/notificaciones/results/resumen.csv`. La decisión final de capacidad sigue pendiente de repeticiones, tiempos de drenaje, utilización de recursos e integridad.
