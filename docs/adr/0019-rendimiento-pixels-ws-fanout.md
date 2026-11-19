# ADR 0019 · Agrupación (micro-batching) y serialización única en el WebSocket de `pixels-api`

- **Estado:** aceptada · **Fecha:** 2026-11-19 · **Escenario:** P3 · Rendimiento `pixels-api` (Stephan García)

## Contexto
Al medir `pixels-api` (Rust/Axum/Tokio) con 1 CPU y 512 MiB de RAM ([`rendimiento/pixels/README.md`](../../rendimiento/pixels/README.md)) encontramos por qué se saturaba al subir los clientes WebSocket conectados:

1. Cada `PLACE_PIXEL` enviaba dos mensajes seguidos por el `broadcast::channel(4096)`: `PIXEL_UPDATED` (con un vector de 1 solo píxel) y `STATS_UPDATED`.
2. En `ws.rs`, cada tarea receptora (`send_task`) clonaba el mensaje y llamaba a `serde_json::to_string(&msg)` por su cuenta ($N$ serializaciones JSON del mismo evento para $N$ clientes).
3. El bucle `while let Ok(msg) = rx.recv().await` trataba `Err(RecvError::Lagged)` como fin del ciclo y cerraba el WebSocket.

Con 1000 clientes concurrentes colocando un píxel cada 5 s, la CPU llegaba al 98,7 %, la latencia p95 subía a 12,6 s y el 100 % de las conexiones terminaban cerradas por `Lagged`.

## Decisión
Añadir agrupación por ventana de tiempo configurable con `PIXELS_BATCH_INTERVAL_MS` (`0` por defecto mantiene el envío inmediato; `50` activa ventanas de 50 ms):
1. Con `PIXELS_BATCH_INTERVAL_MS=50`, los píxeles colocados durante esos 50 ms se guardan en un vector en memoria y una tarea de Tokio emite un solo `PIXEL_UPDATED { pixels: [...] }` más un `STATS_UPDATED` por ventana. Como el mensaje `PIXEL_UPDATED` ya usaba un arreglo `pixels`, el frontend no necesita cambios.
2. El JSON se serializa una sola vez por ventana a `Arc<str>` y se envía por `broadcast_raw_tx`, así las $N$ tareas solo copian el puntero `Arc`.
3. Si un receptor lento recibe `RecvError::Lagged(_)`, continúa leyendo el siguiente lote en vez de cerrar la conexión.

## Alternativas
- *Subir solo el tamaño del canal `broadcast::channel` (p. ej. a 65 536):* aguanta ráfagas más largas antes de dar `Lagged`, pero sigue gastando CPU en serializar el mismo JSON $N$ veces y enviando dos tramas TCP por píxel.
- *Poner varias réplicas de `pixels-api`:* como el lienzo vive en memoria atómica (`AtomicCanvas`), varias réplicas necesitarían Redis o NATS para sincronizar los píxeles entre sí. Con una sola réplica y lotes de 50 ms basta para sostener 1000–2000 clientes en 1 CPU.

## Consecuencias
- (+) A 1000 clientes WS, el p95 baja de 12 624 ms a 137 ms, la CPU baja de 98,7 % a 38,5 % y los cierres por `Lagged` pasan de 100 % a 0 %.
- (+) A 2000 clientes WS se mantienen 0 % de desconexiones y se escriben 23 348 píxeles en 60 s (frente a 398 cuando las conexiones se caían).
- (−) Cuando hay pocos usuarios, un píxel puede tardar hasta 50 ms más en salir por el WebSocket, lo cual no se nota en un lienzo con cooldown de 5 s por usuario.
