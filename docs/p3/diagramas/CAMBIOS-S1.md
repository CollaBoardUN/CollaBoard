## S1 — Secure Channel (TLS terminado en el gateway)

Color del escenario: **azul** (`#1F5FD6`). Los elementos del P2 no cambian de color; las
correcciones de la línea base contra `docker-compose.yml` van en **gris**. Nombres de servicio
idénticos a `docker-compose.yml`. Las cuatro vistas tienen `.drawio` (editable) y `.png`.

Las vistas de despliegue, capas y descomposición se redibujaron fieles a las imágenes del P2
(`docs/Vistas y diagramas/`) porque sus bases en draw.io aún no estaban; al fusionar con
`base/vista-*.base.drawio` basta con copiar los elementos azules (y revisar los grises).

### Vista C&C (`vista-cc.S1.drawio`, hecha sobre `base/vista-cc.base.drawio`)
- Añadido: anotación «secure channel» junto a `gateway`: *Terminación TLS (:443), certificado + HSTS, HTTP :80 → 301 a HTTPS*.
- Añadido: leyenda (negro = P2, azul = S1) que separa el tramo cifrado (navegador/pixels-ui ↔ gateway) del tramo interno (red `internal`, HTTP sin cambios).
- Modificado: conector Browser → gateway (`HTTP / WS` → `HTTPS / WSS :443`, TLS 1.2+).
- Modificado: conector pixels-ui → gateway (`HTTP/REST + WS` → `HTTPS + WSS :443`).
- Eliminado: ninguno. Browser → pixels-ui sigue en `HTTP :3000`: es el archivo estático de la SPA y su publicación es de S2 (punto único de entrada).
- Estilos/patrones a describir en el texto: **Secure Channel** (TLS en el borde) y **Gateway Offloading** (los servicios no gastan CPU en TLS).

### Vista de despliegue (`vista-despliegue.S1.drawio`)
- Añadido: puerto publicado `8443 → 443` en `gateway` (HTTPS/WSS, TLS 1.2/1.3).
- Modificado: `8088 → 80` en `gateway`, etiqueta "solo 301" (redirige a HTTPS; conserva `/healthz`).
- Añadido: volumen `gateway/certs → /etc/nginx/certs` (certificado y llave; no versionado). En desarrollo el gateway crea una CA local con `nameConstraints` (solo localhost) y descarta su llave.
- Añadido: frontera de confianza punteada azul: tramo cifrado (host cliente ↔ `gateway:443`); dentro de la red de contenedores el tráfico sigue en HTTP.
- Corrección de la base (gris): la columna izquierda muestra solo el puerto del contenedor (8001, 8002, … no se publican al host en ningún compose); las bases y RabbitMQ solo se publican en `127.0.0.1` con `docker-compose.dev-ports.yml`; consola de RabbitMQ `127.0.0.1:15672`; `pixels-ui` es `3000 → 80` (la imagen del P2 decía 3001 → 3080).
- Eliminado: ninguno.

### Vista de capas (`vista-capas.S1.drawio`)
- Añadido: en *Communication Tier*, junto a `gateway`, el bloque azul **«secure channel» Terminación TLS** (HTTPS/WSS :443, :80 → 301, HSTS).
- Modificado: flecha *Allow to use* Presentation → Communication con la etiqueta `HTTPS / WSS`.
- Sin cambios: Logic y Data/Messaging (el tramo interno sigue en HTTP dentro de la red aislada).
- Correcciones de la base: `notification-api` y `message-worker` son los servicios C# / .NET 8 reales (no "stub"); `pixels-ui` ya no es un perfil opcional.

### Vista de descomposición (`vista-descomposicion.S1.drawio`)
- Añadido: en el subsistema **Gateway y trazabilidad** → `gateway (Nginx)`, el módulo nuevo **Terminación TLS y certificados** (junto a *Proxy HTTP / WS*, *Enrutar a las APIs*, *X-Request-ID*).
- Archivos del módulo: `gateway/templates/snippets/tls.conf.template`, `gateway/gen-dev-cert.sh`, `gateway/templates/default.conf.template` (servidores :443 y :80).
- Corrección de la base: `pixels-ui (opcional)` → `pixels-ui (React / Vite)`.
- Eliminado: ninguno.
