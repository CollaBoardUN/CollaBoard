# web-ssr · Presentación web con SSR (CollaBoard P2)

Componente **P1 · Web SSR** de la vista C&C del prototipo 2: Next.js 16 + TypeScript.
El servidor renderiza **en cada petición** el dashboard y la cabecera de cada tablero con
los datos reales del usuario; el navegador hidrata el lienzo de Konva, el tiempo real, el chat
y la bandeja de notificaciones.

> Paquete A del plan P2 (Jhon Prieto). Documentación técnica completa:
> [`docs/p2/WEB_SSR.md`](../docs/p2/WEB_SSR.md) · contratos: [`docs/p2/CONTRATOS_WEB.md`](../docs/p2/CONTRATOS_WEB.md)
> · cliente local: [`docs/p2/ADAPTADOR_ELECTRON.md`](../docs/p2/ADAPTADOR_ELECTRON.md).

## Estructura por capas

```
src/
├── app/        Rutas de Next.js (páginas SSR, Server Actions, BFF /bff/*, /healthz)
├── server/     Solo servidor: sesión (cookie HttpOnly), DAL, cliente del gateway, políticas del BFF
├── ui/         Componentes React reutilizables (web y Electron). Sin Next.js
├── core/       Dominio, transporte, APIs tipadas, tiempo real, chat y bandeja. Sin React ni Next.js
└── proxy.ts    Verificación optimista de sesión y X-Request-Id
dev/
├── mocks/      Mocks de Chat (Java) y NotificationAPI (C#) con el contrato acordado
└── gateway/    Gateway Nginx de DESARROLLO (lo reemplaza el gateway definitivo)
tests/          Integración SSR: servidor Next real + gateway falso
```

ESLint impide que `core/` y `ui/` importen Next.js o código de servidor: así el cliente
Electron puede reutilizarlos tal cual.

## Ejecutar

### Todo junto en Docker (recomendado)

Desde la raíz del repositorio:

```bash
docker compose -f docker-compose.p1.yml -f web-ssr/compose.dev.yml up --build -d
```

Abre <http://localhost:8088>. El override agrega `web-ssr`, los mocks y un gateway de
desarrollo sobre el Compose del P1 (Auth, Colaboración, Pizarra, Pixels y sus bases).

### Desarrollo con recarga en caliente

Con el stack anterior arriba (lo necesita para Auth, Colaboración y Pizarra):

```bash
cd web-ssr
npm install
cp .env.example .env.local   # GATEWAY_INTERNAL_URL=http://localhost:8088, PUBLIC_WS_URL=ws://localhost:8088
npm run dev                  # http://localhost:3100
```

## Variables de entorno

Se leen en tiempo de ejecución (la misma imagen sirve en cualquier despliegue). Ver
[`.env.example`](.env.example).

| Variable | Uso | Valor por defecto |
|---|---|---|
| `GATEWAY_INTERNAL_URL` | URL interna del API Gateway (solo rutas `/api/*`) | `http://localhost:8088` |
| `GATEWAY_TIMEOUT_MS` | Tiempo máximo de cada llamada al gateway | `8000` |
| `SESSION_COOKIE_SECURE` | Cookie `Secure` (solo con HTTPS) | `false` |
| `PUBLIC_WS_URL` | Base `ws(s)://` del navegador; vacío = mismo origen | vacío |
| `PUBLIC_PIXELS_URL` | Enlace a Pixels en la barra superior | vacío (oculto) |
| `BFF_ALLOWED_ORIGINS` | Orígenes extra aceptados por el BFF | vacío |

## Pruebas

```bash
npm run lint && npm run typecheck   # ESLint (con límites de capas) y TypeScript estricto
npm test                            # Vitest: unitarias y de componentes (119)
npm run build && npm run test:ssr   # Integración SSR sin Docker (10)
cd dev/mocks && npm test            # Contrato de Chat y Notificaciones (10)
```

De punta a punta, con el stack de Docker arriba (desde la raíz):

```bash
pip install -r e2e/requirements.txt && python -m playwright install chromium
WEB_SSR_URL=http://localhost:8088 pytest e2e/test_web_ssr.py -v
```

## Rutas

| Ruta | Tipo | Descripción |
|---|---|---|
| `/` | SSR | Dashboard con los tableros del usuario |
| `/boards/[boardId]` | SSR + hidratación | Cabecera, rol, estado guardado y chat inicial; lienzo en el navegador |
| `/join/[token]` | SSR + Server Action | Vista previa y aceptación de una invitación |
| `/login`, `/register` | SSR + Server Action | Formularios que funcionan incluso sin JavaScript |
| `/bff/*` | Route Handler | Reenvía al gateway con el Bearer de la cookie (lista blanca, CSRF) |
| `/session/expired` | Route Handler | Borra la cookie y vuelve al login |
| `/healthz` | Route Handler | Healthcheck de Docker |
