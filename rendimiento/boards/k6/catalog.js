import http from 'k6/http';
import { sleep } from 'k6';

export const base = 'https://gateway';
export const userCount = 20;
export const boardsPerUser = 10;
export const timeoutSeconds = 10;

export function request(method, path, body = null, token = '', requestId = '') {
  const headers = { Accept: 'application/json' };
  if (body !== null) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  if (requestId) headers['X-Request-ID'] = requestId;
  return http.request(method, base + path, body === null ? null : JSON.stringify(body), {
    headers,
    redirects: 0,
    timeout: `${timeoutSeconds}s`,
    tags: { name: `${method} ${path}` },
  });
}

export function json(response) {
  const type = response.headers['Content-Type'] || '';
  if (!/^application\/json(?:\s*;|$)/i.test(type)) return null;
  try {
    return response.json();
  } catch (_) {
    return null;
  }
}

export function expect(response, status, operation, userIndex) {
  if (response.status !== status) {
    throw new Error(`${operation}, usuario sintetico ${userIndex}: HTTP ${response.status}, codigo k6 ${response.error_code || 0}`);
  }
}

function auth(path, index, email, body, status) {
  // Four requests per second at most, including registration conflicts.
  const response = request('POST', path, body);
  sleep(0.25);
  if (status === 201 && response.status === 409) return null;
  expect(response, status, path, index);
  const session = json(response);
  if (!session || typeof session.access_token !== 'string' ||
      session.access_token.split('.').length !== 3 ||
      session.token_type !== 'bearer' || !session.user ||
      session.user.email !== email || typeof session.user.id !== 'string' || !session.user.id) {
    throw new Error(`Sesion JSON inesperada para usuario sintetico ${index}`);
  }
  return { id: session.user.id, token: session.access_token, index };
}

export function signIn(index, register = false) {
  const email = `boards-perf-${index}@example.invalid`;
  const password = __ENV.BOARDS_PASSWORD;
  if (!password || password.length < 12) throw new Error('Falta la clave sintetica');
  const credentials = { email, password };
  if (register) {
    const session = auth('/api/auth/register', index, email, {
      ...credentials, name: `Perf Boards ${index}`, confirm_password: password,
    }, 201);
    if (session) return session;
  }
  return auth('/api/auth/login', index, email, credentials, 200);
}

export function boardNames(index) {
  return Array.from({ length: boardsPerUser }, (_, i) => `Perf Boards ${index}-${i + 1}`);
}

export function validBoard(board, account) {
  return board && typeof board.id === 'string' && board.id.length > 0 &&
    typeof board.name === 'string' && board.owner_id === account.id &&
    board.my_role === 'owner' && board.member_count === 1 &&
    typeof board.created_at === 'string' && Number.isFinite(Date.parse(board.created_at)) &&
    typeof board.updated_at === 'string' && Number.isFinite(Date.parse(board.updated_at));
}

export function catalog(response, account, names) {
  const boards = json(response);
  if (!Array.isArray(boards) || boards.length > names.length) return null;
  const ids = new Set();
  const byName = new Map();
  for (const board of boards) {
    if (!validBoard(board, account) || !names.includes(board.name) ||
        ids.has(board.id) || byName.has(board.name)) return null;
    byName.set(board.name, board.id);
    ids.add(board.id);
  }
  return byName;
}
