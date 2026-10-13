# CollaBoard — Servicio de autenticación en Go

Servicio desacoplado de las pizarras de FastAPI. Expone JSON y firma JWT HS256,
con `sub` (UUID estable), `name`, `email`, `iat` y `exp`. Los servicios leen el mismo
`JWT_SECRET` y `JWT_ALGORITHM=HS256`. **No se guardan contraseñas en texto plano:**
se almacenan hashes Argon2id con sal aleatoria.

## API

| Método | Ruta | Descripción |
| --- | --- | --- |
| `POST` | `/auth/register` | `{name,email,password,confirm_password}`. Devuelve 201 y sesión |
| `POST` | `/auth/login` | `{email,password}`. Devuelve sesión |
| `GET` | `/auth/me` | Requiere `Authorization: Bearer <JWT>` |
| `GET` | `/health` | Estado del servicio |

La sesión contiene `{access_token,token_type,user}`. Los errores tienen formato
`{"detail":"mensaje en español"}`. Se usan 400/401/403/409/415/422/429/500.

## Ejecutar

En la **raíz del repositorio**, después de aplicar los cambios:

```sh
# Opcional: crea un .env con JWT_SECRET aleatoria de al menos 32 bytes.
docker compose up --build -d
curl http://localhost:8001/health
```

Para ejecutar Go sin Docker, copia `.env.example` a tus variables de shell,
levanta PostgreSQL, y ejecuta `go mod tidy && go run ./cmd/server`.

## Seguridad y límites del prototipo

- Clave JWT de al menos 32 bytes, compartida con FastAPI; sin credenciales reales
  en Git. Expiración: 1 hora. HTTPS/WSS para cualquier despliegue externo.
- Las contraseñas se validan (12 a 128 bytes); los campos tienen longitud limitada.
  Argon2id (64 MiB, 3 iteraciones, paralelismo 2).
- Rate limit por combinación IP/correo en memoria (10 solicitudes cada 15 minutos):
  debe sustituirse por Redis o gateway si hay varias instancias.
- El cierre de sesión actual elimina el token del navegador. No revoca tokens
  ya firmados; caducan después de una hora. Sin refresh token por ahora.
- CORS permite solamente `FRONTEND_URL`. Usar un origen confiable.
- El frontend actual persiste JWT en localStorage por compatibilidad: reforzar
  política CSP/XSS antes de desplegar públicamente y evaluar cookies HttpOnly.
- No hay verificación ni recuperación de correo ni OAuth Google en este prototipo.
- La migración inicial crea `auth.users` y la tabla `goose_db_version` para
  gestionar cambios, sin modificar el esquema `public` usado por FastAPI.

## Pruebas

```sh
cd authentication-module
go mod tidy
go test ./...
```

También se recomienda ejecutar el flujo Playwright de `e2e/` con ambos servicios.
