import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { vi } from "vitest";

import { useAuth } from "../auth/authStore";
import type { Board } from "../lib/types";
import { useBoards } from "../stores/boardsStore";

/** JWT sin firma válida (el front no verifica firmas, solo lee el contenido). */
export function fakeToken(payload: Record<string, unknown>): string {
  // Igual que un JWT real: JSON en UTF-8 y luego base64url.
  const b64 = (o: unknown) => {
    const bytes = new TextEncoder().encode(JSON.stringify(o));
    const bin = Array.from(bytes, (b) => String.fromCharCode(b)).join("");
    return btoa(bin).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  };
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}.firma`;
}

export function signIn(id = "ana", name = "Ana") {
  useAuth.getState().setSession(fakeToken({ sub: id, name }));
}

export function resetStores() {
  useAuth.getState().logout();
  useBoards.getState().reset();
}

type Handler = (body: unknown) => { status?: number; body?: unknown };

/** Sustituye fetch por un "backend" en memoria: { "GET /boards": () => ({ body: [...] }) } */
export function mockApi(routes: Record<string, Handler>) {
  const calls: { method: string; path: string; body: unknown; headers: Record<string, string> }[] =
    [];
  const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    const path = new URL(url).pathname;
    const body = init.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ method, path, body, headers: (init.headers ?? {}) as Record<string, string> });
    const handler = routes[`${method} ${path}`];
    if (!handler) {
      return new Response(JSON.stringify({ detail: `Sin mock para ${method} ${path}` }), {
        status: 500,
      });
    }
    const { status = 200, body: out } = handler(body);
    return new Response(status === 204 ? null : JSON.stringify(out ?? null), { status });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetchMock };
}

export function renderAt(path: string, routePattern: string, element: ReactElement) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path={routePattern} element={element} />
        <Route path="/boards/:boardId" element={<p>Vista del tablero</p>} />
        <Route path="/login" element={<p>Pantalla de login</p>} />
        <Route path="/" element={<p>Inicio</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

export function makeBoard(over: Partial<Board> = {}): Board {
  return {
    id: "b1",
    name: "Ideas del sprint",
    owner_id: "ana",
    my_role: "owner",
    member_count: 1,
    created_at: "2026-10-10T12:00:00Z",
    updated_at: "2026-10-10T12:00:00Z",
    ...over,
  };
}
