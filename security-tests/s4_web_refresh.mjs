import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const base = process.env.BASE_URL || 'http://localhost:8088';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function check(label, condition) {
  assert.ok(condition, label);
  console.log('OK', label);
}

const email = `s4-web-${randomUUID()}@example.com`;
const password = 'Prueba-Web-S4-2026!';

// 1. Crear un usuario y obtener los tokens iniciales.
const reg = await fetch(`${base}/api/auth/register`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    name: 'Prueba Web S4',
    email,
    password,
    confirm_password: password
  })
});

check('Registro HTTP 201', reg.status === 201);

const initial = await reg.json();

check(
  'Se recibieron access y refresh',
  Boolean(initial.access_token && initial.refresh_token)
);

// 2. Esperar a que expire el access JWT de 5 segundos.
await sleep(6500);

const expired = await fetch(`${base}/api/auth/me`, {
  headers: { Authorization: `Bearer ${initial.access_token}` }
});

check('Access vencido recibe HTTP 401', expired.status === 401);

// 3. Simular navegación hacia la página privada.
const page = await fetch(`${base}/`, {
  headers: { Cookie: `cb_session=${initial.access_token}` },
  redirect: 'manual'
});

const refreshLocation = page.headers.get('location');
const refreshUrl = new URL(refreshLocation || '/', base);

check(
  'La página redirige al mecanismo de refresh',
  page.status === 307 && refreshUrl.pathname === '/session/refresh'
);

// 4. Enviar el refresh HttpOnly, simulando su cookie Path=/session.
const renewal = await fetch(refreshUrl, {
  headers: { Cookie: `cb_refresh=${initial.refresh_token}` },
  redirect: 'manual'
});

check('El refresh web devuelve HTTP 303', renewal.status === 303);

const setCookies = renewal.headers.getSetCookie();

function cookieValue(name) {
  const entry = setCookies.find(c => c.startsWith(`${name}=`));
  if (!entry) return null;
  return decodeURIComponent(entry.split(';', 1)[0].slice(name.length + 1));
}

const newAccess = cookieValue('cb_session');
const newRefresh = cookieValue('cb_refresh');

check(
  'La web establece dos cookies nuevas',
  Boolean(newAccess && newRefresh)
);

check(
  'Ambos tokens cambiaron',
  newAccess !== initial.access_token &&
  newRefresh !== initial.refresh_token
);

// 5. Verificar la navegación con el access renovado.
const destination = new URL(renewal.headers.get('location') || '/', base);

const landing = await fetch(destination, {
  headers: { Cookie: `cb_session=${newAccess}` },
  redirect: 'manual'
});

check(
  'El usuario vuelve a la página autenticada (HTTP 200)',
  landing.status === 200
);

console.log('PRUEBA WEB S4 COMPLETADA');
