// CollaBoard P2: prueba reproducible en una instancia local de desarrollo.
// Node >= 18. No imprime contraseñas ni JWT. Crea un usuario de prueba.
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';

const base = (process.env.BASE_URL || 'http://localhost:8088').replace(/\/$/, '');
const email = `s4-test-${randomUUID()}@example.com`;
const password = `Test-S4-${randomUUID()}!`;
async function call(method, path, body, token) {
  const res = await fetch(base + path, {
    method, redirect: 'manual',
    headers: { ...(body ? {'Content-Type':'application/json'} : {}), ...(token ? {Authorization: `Bearer ${token}`} : {}) },
    ...(body ? {body: JSON.stringify(body)} : {}),
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json().catch(() => null);
  return {status: res.status, data};
}
function check(label, condition, observed) {
  console.log(`${condition ? 'OK' : 'FAIL'} | ${label} | ${observed}`);
  assert.ok(condition, label);
}
try {
  const reg = await call('POST', '/api/auth/register', {name:'Prueba S4',email,password,confirm_password:password});
  check('Registro',reg.status===201,reg.status);
  const login = await call('POST','/api/auth/login',{email,password});
  check('Login',login.status===200,login.status);
  const token = login.data?.access_token;
  assert.ok(token && token.split('.').length===3,'JWT ausente');
  const {iat,exp} = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
  check('TTL P2 de una hora',exp-iat===3600,`${exp-iat} s`);
  check('No se entrega refresh token',!login.data?.refresh_token, 'campo refresh_token ausente');
  const before = await call('GET','/api/boards',undefined,token);
  check('JWT funciona antes de intentar logout',before.status===200,before.status);
  const logout = await call('POST','/api/auth/logout',{},token);
  check('Endpoint de logout servidor no disponible', [404,405].includes(logout.status), logout.status);
  const after = await call('GET','/api/boards',undefined,token);
  check('El mismo JWT continúa autorizando tras intento de logout',after.status===200,after.status);
  console.log('BASELINE P2 reproducida. El OK confirma el problema, no su mitigación.');
  console.log('Complementar con una prueba de logout real de la interfaz SSR para demostrar que solo borra la cookie.');
} catch (err) {
  console.error(`FAIL | ${err.message}`);
  process.exitCode=1;
}
