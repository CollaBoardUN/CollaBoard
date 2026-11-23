| Origen | gateway:80 | gateway:8081 | web-ssr:3000 | auth-api:8001 | collaboration-api:8000 | pizarra-api:8000 | chat-api:8090 | pixels-api:8000 | notification-api:8080 | user-db:5432 | board-db:5432 | canvas-db:5432 | notification-db:5432 | pixels-nosqldb:27017 | rabbitmq:5672 | Internet (1.1.1.1:443) |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| `gateway` | — | — | OK (ALLOW) | OK (ALLOW) | OK (ALLOW) | OK (ALLOW) | OK (ALLOW) | OK (ALLOW) | OK (ALLOW) | OK (DENY) | OK (DENY) | OK (DENY) | OK (DENY) | OK (DENY) | OK (DENY) | — |
| `web-ssr` | — | OK (ALLOW) | — | — | — | — | — | — | — | OK (DENY) | OK (DENY) | OK (DENY) | OK (DENY) | OK (DENY) | OK (DENY) | OK (BLOQUEADO) |
| `auth-api` | — | — | — | — | — | — | — | — | — | OK (ALLOW) | OK (DENY) | OK (DENY) | OK (DENY) | OK (DENY) | OK (DENY) | OK (BLOQUEADO) |
| `collaboration-api` | — | — | — | — | — | OK (ALLOW) | — | — | OK (ALLOW) | OK (DENY) | OK (ALLOW) | OK (DENY) | OK (DENY) | OK (DENY) | OK (DENY) | OK (BLOQUEADO) |
| `pizarra-api` | — | — | — | — | OK (ALLOW) | — | — | — | — | OK (DENY) | OK (DENY) | OK (ALLOW) | OK (DENY) | OK (DENY) | OK (DENY) | OK (BLOQUEADO) |
| `chat-api` | — | — | — | — | OK (ALLOW) | — | — | — | OK (ALLOW) | OK (DENY) | OK (DENY) | OK (DENY) | OK (DENY) | OK (ALLOW) | OK (DENY) | OK (BLOQUEADO) |
| `pixels-api` | — | — | — | — | — | — | — | — | — | OK (DENY) | OK (DENY) | OK (DENY) | OK (DENY) | OK (ALLOW) | OK (DENY) | OK (BLOQUEADO) |
| `notification-api` | — | — | — | — | — | — | — | — | — | OK (DENY) | OK (DENY) | OK (DENY) | OK (ALLOW) | OK (DENY) | OK (ALLOW) | OK (BLOQUEADO) |
| `message-worker` | OK (DENY) | OK (DENY) | OK (DENY) | OK (DENY) | OK (DENY) | OK (DENY) | OK (DENY) | OK (DENY) | — | OK (DENY) | OK (DENY) | OK (DENY) | OK (ALLOW) | OK (DENY) | OK (ALLOW) | OK (BLOQUEADO) |