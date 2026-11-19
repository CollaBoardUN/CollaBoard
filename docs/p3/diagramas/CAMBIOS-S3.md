## S3 — Network Segmentation (zonas edge / app / datos / mensajería)

Color del escenario: **naranja** (`#E65100`). Los elementos del P2 se dejan en negro y las correcciones de la base en gris. Nombres de servicio iguales a `docker-compose.yml`. Todas las vistas tienen su `.drawio` editable y el `.png` exportado.

### Vista C&C (`vista-cc.S3.drawio`, sobre `base/vista-cc.base.drawio`)
- Añadido: 8 fronteras de zona («network zone») punteadas en naranja:
  - `edge` (salida al host: `gateway` y `pixels-ui`).
  - `app` (`internal: true`: `gateway`, `web-ssr` y las 6 APIs HTTP).
  - 6 zonas de datos y mensajería (`internal: true`): `net-user` (`auth-api` ↔ `user-db`), `net-board` (`collaboration-api` ↔ `board-db`), `net-canvas` (`pizarra-api` ↔ `canvas-db`), `net-notif` (`notification-api` y `message-worker` ↔ `notification-db`), `net-mongo` (`chat-api` y `pixels-api` ↔ `pixels-nosqldb`) y `net-mq` (`notification-api` y `message-worker` ↔ `rabbitmq`).
- Añadido: nota en `net-mongo` sobre el riesgo residual de compartir el contenedor de MongoDB (credenciales separadas, ADR 0010 / ADR 0013) y leyenda en naranja.
- Modificado: la caja única `internal` del P2 pasa a ser la zona `app` más las 6 zonas `net-*`; `message-worker` queda fuera de `app`.
- Eliminado: ninguno (los conectores de negocio del P2 eran los mismos; lo que se quita es el alcance de red entre pares que no tenían conector).
- Estilos/patrones a describir en el texto: **Network Segmentation** (tácticas: *Separate entities*, *Limit access*, *Limit exposure*).

### Vista de despliegue (`vista-despliegue.S3.drawio`, sobre `base/vista-despliegue.base.drawio`)
- Añadido: las 8 redes reales del compose (`edge`, `app`, `net-user`, `net-board`, `net-canvas`, `net-notif`, `net-mongo`, `net-mq`), marcando `internal: true` en las 7 internas.
- Añadido: etiquetas naranjas en cada contenedor con las redes a las que pertenece (`auth-api: app, net-user`, `message-worker: net-notif, net-mq (sin app)`, etc.).
- Modificado: se reemplaza `container-network` por las zonas reales; la consola de RabbitMQ (`127.0.0.1:15672`) se anota como parte de `docker-compose.dev-ports.yml`.
- Eliminado: la red única `container-network`.

### Vista de capas (`vista-capas.S3.drawio`)
- Añadido: correspondencia entre capas y zonas de red en naranja:
  - `edge` en Presentation / entrada externa del gateway.
  - `app (internal: true)` en Logic Tier (con la nota en `message-worker` indicando que no entra a `app`).
  - 6 bloques separados en Data / Messaging Tier (`net-user`, `net-board`, `net-canvas`, `net-notif`, `net-mongo`, `net-mq`).
- Modificado: el uso de la capa Lógica hacia Datos queda partido por dominio en lugar de entrar a una red común.
- Eliminado: ninguno.

### Vista de descomposición (`vista-descomposicion.S3.drawio`)
- Añadido: en el subsistema **Gateway y trazabilidad** → `gateway (Nginx)`, el módulo **Política de zonas de red (`edge / app / net-*`)**.
- Añadido: en **Infraestructura de datos**, la etiqueta de red (`net-user`, `net-board`, `net-canvas`, `net-notif`, `net-mongo`, `net-mq`) al lado de cada almacén.
- Modificado: ninguno.
- Eliminado: ninguno.

### Diagrama de secuencia (`secuencia-S3.drawio`)
- Archivo: `docs/p3/diagramas/secuencia-S3.drawio` (y `.png`).
- Compara qué pasa si comprometen `pixels-api` e intenta conectarse a `user-db:5432` y salir a `1.1.1.1:443`: en el P2 ambos hacen `SYN → SYN-ACK`; en el P3 `pixels-nosqldb:27017` sigue respondiendo en `net-mongo`, pero `user-db` da `NXDOMAIN / DROP` y la salida a Internet da `Network unreachable`.
