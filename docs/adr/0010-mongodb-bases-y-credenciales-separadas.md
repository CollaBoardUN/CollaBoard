# ADR 0010 · MongoDB con dos bases y credenciales separadas

- **Estado:** aceptada · **Fecha:** 2026-10-28 · **Paquete:** F (infraestructura) con Estefan (Pixels) y Marlon (Chat)

## Contexto
El plan (sección 1, ajuste 3 y conector C11) pide que Chat use la base lógica `chat` en la **misma instancia** MongoDB que Pixels
(`collaboard_pixels`), «aislada por base y credencial»; solo Chat accede a sus mensajes.

## Decisión
- Una instancia `pixels-nosqldb` (`mongo:7`) con **autenticación activada** (usuario root solo para administrar).
- `mongo/init/10-create-databases.sh` (se ejecuta **solo con el volumen vacío**) crea dos usuarios con rol `readWrite` limitado a su base:
  `pixels` → `collaboard_pixels` y `chat` → `chat`. Credenciales distintas en `.env`.
- Cadenas de conexión con `authSource` explícito:
  - Pixels: `mongodb://pixels:…@pixels-nosqldb:27017/collaboard_pixels?authSource=collaboard_pixels`
  - Chat: `mongodb://chat:…@pixels-nosqldb:27017/chat?authSource=chat`
- Verificado: ambos servicios arrancan y operan con su usuario; las pruebas de Chat (17/17) pasan contra una base `chat` desechable.

## Alternativas
- *Sin autenticación (como en el P1):* cualquier servicio de la red lee y escribe en cualquier base.
- *Dos contenedores Mongo:* el plan cuenta una sola instancia y evita un contenedor extra.

## Consecuencias
- (+) Aislamiento real por base y credencial con un solo contenedor.
- (−) El script de init no vuelve a ejecutarse si el volumen ya existe: para cambiar usuarios hay que recrear el volumen (`docker compose down -v`) o crearlos a mano.
- (−) Un MongoDB sin réplica no ofrece transacciones multidocumento; Chat guarda el evento pendiente dentro del propio documento del mensaje (decisión del plan, no de la infraestructura).
