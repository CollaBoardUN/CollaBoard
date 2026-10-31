# Chat API de CollaBoard P2 (Java)

Servicio Spring Boot con Java 21 y MongoDB 7. Implementa el contrato público de
[`docs/p2/CONTRATOS_WEB.md`](../docs/p2/CONTRATOS_WEB.md). No requiere instalar Maven
ni reemplazar Java 8 del equipo: la compilación se hace en el builder de Docker.

## Levantar P2 desde la raíz del repositorio

Requisitos: Docker Desktop en modo contenedores Linux, Docker Compose v2 y acceso a
Docker Hub/Maven Central durante la primera compilación. Docker debe estar iniciado.

```powershell
docker compose -f docker-compose.yml -f web-ssr/compose.dev.yml build chat-api pizarra-backend web-ssr dev-mocks
docker compose -f docker-compose.yml -f web-ssr/compose.dev.yml up --build -d
```

Abrir **http://localhost:8088** desde Antigravity. El gateway envía exclusivamente
`/api/chat/*` y `/ws/chat/*` a `chat-api:8090`. Las rutas de NotificationAPI siguen
dirigiéndose a `dev-mocks:4100`: **NotificationAPI C# todavía no está integrada**.
El outbox envía sus eventos al endpoint interno del mock, sin publicar `/internal/*`.
No hay que iniciar ni mantener el antiguo Chat mock como servicio real.

MongoDB se reutiliza del servicio `pixels-nosql-db`, pero todos los documentos e
índices de Chat viven en la base **`chat`**; Pixels conserva su propia base. El
volumen Mongo existente mantiene el historial y los eventos pendientes al reiniciar.
No usar `down -v` si se quiere conservar esos datos.

Para consultar estado y logs después de levantarlo:

```powershell
docker compose -f docker-compose.yml -f web-ssr/compose.dev.yml ps chat-api
docker compose -f docker-compose.yml -f web-ssr/compose.dev.yml logs --tail=100 chat-api
```

### Entrega en vivo y cambio de configuración del proxy

Si el panel muestra «Reconectando», usa sondeo HTTP cada cuatro segundos; no está
recibiendo la difusión WebSocket. La ruta `/ws/chat/` debe conservar explícitamente
`Host` y las cabeceras de correlación/forwarding: al declarar `Upgrade` y
`Connection`, Nginx deja de heredar los `proxy_set_header` del bloque superior.
Sin esa configuración envía `Host: chat_api`, que Tomcat rechaza con HTTP 400.

Para aplicar un cambio de `nginx.conf` al gateway que ya está encendido, sin
recompilar Java/web ni reiniciar el stack:

```powershell
docker compose -f docker-compose.yml -f web-ssr/compose.dev.yml exec -T dev-gateway nginx -t
docker compose -f docker-compose.yml -f web-ssr/compose.dev.yml exec -T dev-gateway nginx -s reload
```

La regresión del proxy utiliza el archivo real de Nginx y upstreams de prueba
aislados; no usa las cuentas, mensajes ni contenedores del stack:

```powershell
python web-ssr/dev/gateway/test_chat_proxy.py -v
```

## API y seguridad

- `GET /api/chat/boards/{id}/messages?limit=30`: última página, en orden cronológico.
  `limit`: 1–100. `before` usa el cursor opaco de `next_cursor`; `after` usa un id
  del mismo tablero y devuelve hasta `limit` mensajes posteriores. Para recuperar
  más, continuar con el último id recibido. `before` y `after` son excluyentes.
  Fechas a precisión de milisegundos e id como desempate estable. Cursores inválidos: 422.
- `POST` en la misma ruta: `{"text":"Hola","client_message_id":"cliente-0001"}`.
  Texto recortado de 1–2000 unidades UTF-16 (igual que el cliente web), id de 8–64
  caracteres `[A-Za-z0-9-]`. Primer envío: 201; reintento: 200 y el mensaje original,
  aunque cambie el texto. Índice único por tablero/remitente/id del cliente.
  Autor y nombre salen del JWT. Usuarios de solo lectura también pueden conversar.
- HTTP requiere Bearer. JWT HS256 con `sub` no vacío, `exp` obligatorio y vigente,
  issuer `collaboard-auth`, y `name`/`email` compatibles con Auth Go. No hay modo
  de autenticación simulado ni contraseña de usuario generada por Spring Security.
- `WS /ws/chat/boards/{id}`: cookie `cb_session` con un `Origin` permitido para el
  navegador; Bearer en el handshake para Electron (puede omitir `Origin`). Nunca
  se extraen credenciales de la URL. Sin sesión: cierre 4401; sin acceso: 4403.
  Origen no permitido: handshake HTTP 403. Lista explícita, sin comodines.
- Solo se admite `{"type":"ping"}` y se responde `pong`. JSON inválido devuelve
  `error/bad_message`; cualquier intento de escribir devuelve `error/http_only`
  sin persistir. La difusión usa `{"type":"message","message":...}`.
- Se comprueba membresía al conectar, cada 15 s y **antes de cada entrega**; también
  se revalida la expiración del JWT. Al retirarse un miembro se cierra con 4403.
  Si Colaboración no responde, se suspende la entrega y se cierra 1011 para poder
  reconectar. El historial HTTP tampoco concede acceso en esa situación (503).
- `GET /health`: público; comprueba MongoDB y responde 200 o 503. Los errores HTTP
  incluyen `detail` en español. Se devuelve `X-Request-Id`; los logs excluyen
  tokens, cabeceras, cuerpos y query strings.

La autorización real usa `GET /boards/{id}` y `GET /boards/{id}/members` con el
Bearer original. `BoardPermissions` desacopla Chat de esas rutas; la implementación
HTTP tiene URL y prefijo configurables, sin modificar Colaboración ni sus contratos.

## Persistencia y notificaciones

El mensaje contiene su evento `chat.message.created` y estado `PENDING` en el
**mismo documento**, insertado atómicamente con escritura majority+journal. No
necesita un replica set para transacciones multidocumento. El evento conserva
`event_id`, destinatarios sin el autor, nombre del tablero y vista previa.

Cada 4 s el outbox recupera hasta 50 pendientes y llama `POST /internal/events`
con `X-Service-Token`. Solo un 202 marca `SENT`; cualquier otro resultado conserva
el evento para reintentar, también después de reiniciar Java. La entrega es al
menos una vez: NotificationAPI debe deduplicar por `(event_id, recipient_id)` como
exige el contrato. La caída de NotificationAPI no revierte el mensaje guardado.

Esta versión usa **una instancia de Chat** para la difusión WebSocket en memoria.
Varias réplicas necesitarían un bus de difusión compartido; MongoDB y la
idempotencia no sustituyen ese bus. Los permisos se consultan antes de entregar,
pero no existe una transacción distribuida entre Colaboración y Chat.

## Configuración

`.env.example` enumera las variables. El Compose proporciona sus valores de
desarrollo; no carga automáticamente `chat-module/.env`. Para cambiar sustituciones
del Compose, exportar variables en PowerShell o usar un archivo de entorno de
Compose explícito. Para lanzar Java fuera de Compose, pasar las variables al proceso.

| Variable | Uso |
|---|---|
| `PORT` | Puerto de Java; 8090 por defecto |
| `JWT_SECRET` | Mismo secreto HS256 de Auth; mínimo 32 bytes; obligatorio |
| `JWT_ISSUER` | `collaboard-auth` |
| `MONGODB_URI` | URI Mongo; la base efectiva está fijada a `chat` |
| `COLLABORATION_URL` | URL del backend real; en Compose `http://colaboracion-backend:8000` |
| `COLLABORATION_BOARDS_PATH` | `/boards`; cambiar solo si cambia el contrato interno |
| `COLLABORATION_TIMEOUT_MS` | 4000 por defecto |
| `NOTIFICATIONS_URL` | Base del receptor de eventos; mock en desarrollo |
| `NOTIFICATIONS_SERVICE_TOKEN` | Identidad del servicio; obligatorio y coincidente con el receptor |
| `NOTIFICATIONS_POLL_MS` | Intervalo de reintento; 4000 por defecto |
| `CHAT_ALLOWED_ORIGINS` | Orígenes HTTP(S) completos separados por coma, sin ruta ni comodines |
| `CHAT_RECHECK_MS` | Revalidación periódica de sesiones; 15000 por defecto |

Orígenes locales predeterminados: `http://localhost:8088,http://127.0.0.1:8088`.
Para otros hosts/puertos, añadir **solo** los orígenes necesarios. Los secretos de
ejemplo son únicamente de desarrollo y deben reemplazarse antes de un despliegue.

## Compilar y ejecutar pruebas sin Java/Maven local

Desde la raíz, compilar la imagen final sin iniciar la aplicación:

```powershell
docker build -t collaboard-chat-api ./chat-module
```

El Dockerfile compila y empaqueta, pero las pruebas de integración requieren un
MongoDB separado. Estos comandos crean un Mongo **desechable**, sin puertos
publicados ni acceso al volumen de Pixels. No apuntar `TEST_MONGODB_URI` a datos
reales: las pruebas borran la colección `messages` de `chat` entre escenarios.

```powershell
docker network create collaboard-chat-contract-tests
docker run --rm -d --name collaboard-chat-contract-mongo --network collaboard-chat-contract-tests --tmpfs /data/db mongo:7
docker build --target build -t collaboard-chat-build ./chat-module
docker run --rm --network collaboard-chat-contract-tests -e TEST_MONGODB_URI=mongodb://collaboard-chat-contract-mongo:27017/chat collaboard-chat-build mvn -B -ntp verify
docker stop collaboard-chat-contract-mongo
docker network rm collaboard-chat-contract-tests
```

Las pruebas usan el HTTP y WebSocket reales de Java y MongoDB real. Simulan
únicamente Colaboración y NotificationAPI con servidores auxiliares de prueba.
Cubren validación JWT, origen, permisos/revocación, texto, paginación y empates,
duplicados concurrentes, eventos durables y reintentos. No sustituyen la
comprobación visual con dos usuarios en Antigravity ni una integración con el
futuro servicio C# real.
