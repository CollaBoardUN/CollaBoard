# Estudios de Rendimiento — CollaBoard (Prototipo 3)

Índice unificado de todas las campañas de carga, estrés y costo de seguridad ejecutadas con `k6`, `docker stats` y PostgreSQL `pg_stat_activity`.

| Subcarpeta | Servicio / Escenario | Hallazgo principal |
|---|---|---|
| [`boards/`](boards/) y [`boards/lab6-curva-3000vus/`](boards/lab6-curva-3000vus/) | `collaboration-api` (`GET /api/boards`, `1..3.000` VUs) | Bloqueo `idle in transaction` (`15/15`) corregido con `pool_size`; rodilla en `150–300` VUs, último nivel limpio `2.200` VUs (`0%` error), quiebre exacto en `2.400` VUs |
| [`pizarra-ws/`](pizarra-ws/) | `pizarra-api` WebSocket (`1..200` VUs + control multisala) | Óptimo `50` VUs (`p95 = 210 ms`, `99.6%` ack), rodilla `75` VUs (`99.2%` CPU), saturación por fan-out $O(N^2)$ confirmada con control multisala (`0.0% → 80.6%` ops) |
| [`pixels/`](pixels/) | `pixels-api` Rust WebSocket (`50..1.500` VUs) | Batching cada `50 ms` estabiliza `p95` y CPU hasta `1.500` VUs |
| [`tls/`](tls/) | `reverse-proxy` TLS 1.3 vs HTTP plano y segmentación S3 | Sobrecarga TLS 1.3 marginal con reutilización HTTP/2 |
| [`notificaciones/`](notificaciones/) | `notification-api` + RabbitMQ + `message-worker` | Escalado con consumidores competidores |
| [`rbac/`](rbac/) | `collaboration-api` PDP + `pizarra-api` / `chat-api` PEP | Impacto de caché de permisos `2 s` en latencia |
