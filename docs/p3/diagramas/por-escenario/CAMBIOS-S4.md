## S4 — JWT corto, refresh rotatorio y revocación (Cristian García)

**Color de integración:** morado. Los cuatro diagramas `.drawio` entregados son **vistas parciales S4** editables; el equipo debe copiar los elementos nuevos a las cuatro vistas maestras fusionadas de P3 y conservar todos los elementos S1, S2, S3, S5 y S6.

### Vista C&C
- Añadido: interfaz `POST /auth/refresh`, `POST /auth/logout` en `auth-api` y relación con la sesión de `web-ssr`.
- Añadido: conectores `web-ssr → gateway → auth-api` (HTTP REST interno); `auth-api → user-db` (PostgreSQL :5432 para refresh tokens).
- Modificado: sesión web (una cookie de access y otra de refresh); `auth-api` (JWT de 15 minutos).
- Eliminado: ninguno. No se añaden nuevos contenedores.
- Estilo/patrón: Token-Based Authentication / Security Session, revocación por familia.

### Vista de despliegue
- Añadido: configuración `JWT_ACCESS_TTL` de `auth-api` y almacenamiento `auth.refresh_tokens` en `user-db`.
- Modificado: anotación de cookies HttpOnly/SameSite, atributo `Secure` de S1, secretos no visibles en el dibujo.
- Eliminado: ninguno.
- Se conservan los puertos y redes aprobados por S1/S2/S3. No representar dos contenedores para Gateway/Reverse Proxy.

### Vista de capas
- Añadido en Presentación: `Security Session` en BFF `web-ssr`.
- Añadido en Lógica: `Refresh Token Service` y `Session Revocation` en `auth-api`.
- Añadido en Datos: tabla `auth.refresh_tokens` dentro de `user-db`.
- Modificado: relaciones de dependencia de los módulos de sesión a lógica y persistencia.
- Eliminado: ninguno.

### Vista de descomposición
- Añadido al subsistema Identidad, dentro de `auth-api`: `Refresh y sesión`, `Revocación`.
- Añadido al subsistema Presentación: gestión de cookies dentro del BFF.
- Modificado: `user-db` recibe tabla de refresh.
- Eliminado: ninguno; se mantienen Registro, Login y Tokens existentes.

### Diagrama de secuencia
- Archivo: `secuencia-s4.drawio` + PNG. Secuencia resumida de login → refresh → replay → 401 y familia revocada.
- Para documento final ampliar la secuencia con requests individuales (login, refresh, logout), timestamps TTL, accesos a BD y respuesta precisa del ataque P2/P3.
