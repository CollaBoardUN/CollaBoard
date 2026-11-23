import { sleep } from 'k6';
import {
  boardNames, boardsPerUser, catalog, expect, json, request, signIn, userCount, validBoard,
} from './catalog.js';

export const options = {
  insecureSkipTLSVerify: false,
  setupTimeout: '5m',
  scenarios: { seed: { executor: 'shared-iterations', vus: 1, iterations: 1, maxDuration: '10m' } },
};

export function setup() {
  // setup exceptions produce a nonzero exit without printing credentials or bodies.
  for (let index = 1; index <= userCount; index++) {
    const account = signIn(index, true);
    const names = boardNames(index);
    const before = request('GET', '/api/boards', null, account.token);
    expect(before, 200, 'Listar para sembrar', index);
    const existing = catalog(before, account, names);
    if (!existing) throw new Error(`Catalogo inesperado para usuario sintetico ${index}`);

    for (const name of names) {
      if (existing.has(name)) continue;
      sleep(0.05);
      const response = request('POST', '/api/boards', { name }, account.token);
      expect(response, 201, 'Crear tablero', index);
      const board = json(response);
      if (!validBoard(board, account) || board.name !== name) {
        throw new Error(`Tablero JSON inesperado para usuario sintetico ${index}`);
      }
    }

    const after = request('GET', '/api/boards', null, account.token);
    expect(after, 200, 'Verificar siembra', index);
    const seeded = catalog(after, account, names);
    if (!seeded || seeded.size !== boardsPerUser) {
      throw new Error(`Siembra incompleta para usuario sintetico ${index}`);
    }
  }
}

export default function () {}

export function handleSummary() {
  return { stdout: `Siembra verificada: ${userCount} usuarios, ${boardsPerUser} tableros por usuario.\n` };
}
