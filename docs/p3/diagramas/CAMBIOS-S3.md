## S3 — Network Segmentation (zonas edge / app / datos / mensajería)

### Cambios en las 4 vistas principales: **ninguno (se dejan como están)**

En **S3 (Network Segmentation)** no se añade, elimina ni modifica ningún componente de software, contenedor, conector lógico, capa (*tier*) ni módulo de código: los 16 servicios y almacenes del sistema son exactamente los mismos del Prototipo 2. Lo único que cambia es la partición de la red de Docker Compose (`internal` → `app` + 6 redes `net-*` con `internal: true`).

Por lo tanto:
- **Las 4 vistas arquitectónicas principales (C&C, Despliegue, Capas y Descomposición) no tienen cambios de componentes y se dejan como están** (la línea base limpia de Despliegue queda en `docs/p3/diagramas/base/vista-despliegue.base.drawio`).
- Todos los diagramas con anotaciones explicativas de las zonas de red para sustentar el escenario S3 se guardan en la subcarpeta [`docs/p3/diagramas/explicacion-S3/`](explicacion-S3/):
  - `explicacion-S3/vista-despliegue.S3.drawio` (y `.png`): muestra cómo se agrupan los contenedores existentes en `edge`, `app` y las 6 redes `net-*`.
  - `explicacion-S3/vista-cc.S3.drawio` (y `.png`): superpone las fronteras de zona sobre el C&C.
  - `explicacion-S3/vista-capas.S3.drawio` (y `.png`): muestra la relación entre capas y zonas de red.
  - `explicacion-S3/vista-descomposicion.S3.drawio` (y `.png`): referencia de configuración de redes.
  - `explicacion-S3/secuencia-S3.drawio` (y `.png`): diagrama de secuencia comparando el intento lateral `pixels-api → user-db:5432` y salida a `1.1.1.1:443` en P2 vs P3.
  - `explicacion-S3/vista-despliegue-perf-pixels.drawio` (y `.png`): topología usada durante la prueba de rendimiento con `k6`.
