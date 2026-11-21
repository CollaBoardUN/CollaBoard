#!/usr/bin/env node
/** Prueba end-to-end de contrato S4 contra el gateway real.
 * Requiere Node 22 y un stack local. No coloca secretos en logs.
 * BASE_URL=http://localhost:8088 node security-tests/s4_sesion.mjs
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const root = (process.env.BASE_URL || 'http://localhost:8088').replace(/\/$/, '');
const statuses = [];
async function req(method, route, body, token) {
  const res = await fetch(root+route, {
    method, headers: {...(body ? {'content-type':'application/json'} : {}),...(token ? {authorization:`Bearer ${token}`} : {})},
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  let json;try { json=JSON.parse(text) } catch {json={}}
  return { status:res.status, json };
}
function test(name, condition) {
  statuses.push([name,condition]);
  console.log(`${condition ? 'OK' : 'FAIL'} ${name}`);
}
function exp(token) {
  try {return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).exp} catch{return 0}
}
const email = `s4-${randomUUID()}@example.com`;
const user={name:'Prueba Sesion S4',email,password:'S4-Password-Fuerte-2026!', confirm_password:'S4-Password-Fuerte-2026!'};
try {
  const reg = await req('POST','/api/auth/register',user);
  assert.equal(reg.status,201,`Registro: ${reg.status}`);
  const s1=reg.json;
  test('Registro entrega access y refresh opaco', !!s1.access_token && /^[A-Za-z0-9_-]{43}$/.test(s1.refresh_token));
  const accessPayload=JSON.parse(Buffer.from(s1.access_token.split('.')[1], 'base64url').toString());
  const ttl=exp(s1.access_token)-accessPayload.iat;
  test('JWT TTL <= 15min, con jti', ttl>0 && ttl<=900 && !!accessPayload.jti);
  const valid = await req('GET','/api/auth/me',undefined,s1.access_token);
  test('Access válido permite /auth/me',valid.status===200);
  const rotated = await req('POST','/api/auth/refresh',{refresh_token:s1.refresh_token});
  test('Refresh válido rota los dos tokens',rotated.status===200 && rotated.json.refresh_token!==s1.refresh_token && rotated.json.access_token!==s1.access_token);
  const replay = await req('POST','/api/auth/refresh',{refresh_token:s1.refresh_token});
  test('Replay de refresh anterior se rechaza (401)',replay.status===401);
  const family=await req('POST','/api/auth/refresh',{refresh_token:rotated.json.refresh_token});
  test('Replay revoca toda la familia',family.status===401);
  const login=await req('POST','/api/auth/login',{email,password:user.password});
  assert.equal(login.status,200,`Login: ${login.status}`);
  const end=await req('POST','/api/auth/logout',{refresh_token:login.json.refresh_token});
  test('Logout devuelve 204',end.status===204);
  const after=await req('POST','/api/auth/refresh',{refresh_token:login.json.refresh_token});
  test('Logout invalida refresh',after.status===401);
  const broken=await req('GET','/api/auth/me',undefined,login.json.access_token+'a');
  test('JWT manipulado no se acepta',broken.status===401);
  const [head,payload] = login.json.access_token.split('.');
  const noneHeader=Buffer.from(JSON.stringify({alg:'none',typ:'JWT'})).toString('base64url');
  const none=await req('GET','/api/auth/me',undefined,noneHeader+'.'+payload+'.');
  test('JWT alg=none no se acepta',none.status===401);
  if (process.env.EXPECT_TTL_5S==='1') {
    await new Promise(resolve=>setTimeout(resolve,6000));
    const expired=await req('GET','/api/auth/me',undefined,login.json.access_token);
    test('Access expirado en TTL de prueba (5s)',expired.status===401);
  }
} catch(e) {
  console.error('FAIL Ejecución interrumpida:', e.message);
  process.exitCode=1;
}
if(statuses.some(([,pass])=>!pass))process.exitCode=1;
console.log(`${statuses.filter(([,ok])=>ok).length}/${statuses.length} verificaciones correctas.`);
