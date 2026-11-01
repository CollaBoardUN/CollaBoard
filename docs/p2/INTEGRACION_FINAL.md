# Integración del prototipo 2

Rama de revisión: `codex/integracion-prototipo-2`, basada en `main`.
Incluye las ramas de Web SSR, tiempo real y Chat Java, notificaciones C#,
colaboración e identidad, persistencia y Pixels, y gateway/RabbitMQ.
Se conserva la organización de módulos del equipo. Electron queda fuera del alcance.

## Inicio

En una instalación nueva, copiar `.env.example` a `.env` y ajustar las variables.
En este equipo `.env` ya está preparado y los datos anteriores fueron copiados.

```powershell
docker compose -p collaboard -f docker-compose.yml -f notifications-module/compose.gateway.yml up -d --build
```

Web: http://localhost:8088. Pixels: http://localhost:3000.
El entorno usa servicios reales, incluyendo NotificationAPI y MessageWorker C#.
Los overlays `stubs`, `compat-shared-db` y `notifications-mock` son históricos;
no se usan en la configuración final. El proyecto Docker temporal de revisión
queda detenido. Las bases anteriores y los respaldos locales se conservan.

## Ajustes de integración

- URLs y token interno compartido entre Pizarra, Colaboración y notificaciones.
- Healthcheck de Pixels adaptado a su imagen Rust.
- Unificación del historial de migraciones de Colaboración; la revisión histórica
  de Canvas se conserva como identificador, y CanvasDB se migra desde Pizarra.
- Autorización de Pizarra: un fallo al consultar Colaboración no concede acceso.
- Pruebas de Pizarra con doble explícito del contrato HTTP de Colaboración.
  El WebSocket de dibujo se verifica en la suite de Pizarra; Colaboración verifica
  que no publica ese WebSocket.
- Compatibilidad de la prueba de reinicio SQLite con Windows.
- Correcciones de lint (imports, formato y zip con strict explícito).

## Validación local

- Colaboración: 65 pruebas.
- Pizarra: 111 pruebas SQLite; historial: 16 de ellas.
- Web SSR: lint, tipos y 142 pruebas.
- Gateway: 43 comprobaciones.
- Recorrido web completo en servicios reales: 3/3, también en el proyecto final
  `collaboard` y el puerto 8088.
- Notificaciones reales: aceptación, deduplicación, entrega por worker, privacidad
  y marcado de lectura.
- Alembic CanvasDB: sin diferencias entre migraciones y modelos.
- Migración local: usuarios, tableros, miembros, invitaciones, estado, historial
  y colecciones MongoDB preservados mediante los scripts del equipo y respaldos.

Los registros de esta revisión están en `output/` (sin versionar).

## GitHub Actions

El workflow usa Ubuntu 24.04 y acciones con runtime Node 24, prueba Pixels como
Rust y compila ambos ejecutables C#. El job completo levanta los servicios reales
con bases separadas y exige que pasen las suites de los módulos.
La ejecución remota de Actions requiere publicar la rama/PR; los fallos históricos
permanecen en GitHub y no cambian al corregir el código local.

## Revisión antes de main

Probar dos sesiones: crear tablero, compartir, aceptar invitación, dibujar,
recargar para comprobar persistencia, enviar chat y recibir notificaciones.
Revisar roles viewer/editor y probar Pixels. Después revisar el diff de esta
rama contra main y publicar la integración cuando el responsable la apruebe.
No se ha hecho push ni se ha modificado main remoto durante esta integración.
