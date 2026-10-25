/**
 * Dobles de prueba: transporte con rutas en memoria, socket controlable y un
 * render con los mismos proveedores que usa la web (sin Next.js).
 */
import { render, type RenderResult } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { vi } from "vitest";

import type { Board, SessionUser } from "@/core/domain/types";
import {
  SOCKET_CLOSED,
  SOCKET_CONNECTING,
  SOCKET_OPEN,
  type HttpRequest,
  type HttpResponse,
  type SocketLike,
  type Transport,
} from "@/core/transport/types";
import { AppProvider, type ClientConfig } from "@/ui/AppContext";
import { NavigationProvider, type Navigation, type NavLinkProps } from "@/ui/navigation";

export class FakeSocket implements SocketLike {
  readyState = SOCKET_CONNECTING;
  sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;

  constructor(readonly path: string) {}

  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = SOCKET_CLOSED;
  }
  open() {
    this.readyState = SOCKET_OPEN;
    this.onopen?.();
  }
  receive(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  drop(code = 1006) {
    this.readyState = SOCKET_CLOSED;
    this.onclose?.({ code });
  }
}

type Handler = (request: HttpRequest) => Partial<HttpResponse> | Promise<Partial<HttpResponse>>;

/** `routes`: { "GET /api/boards": () => ({ body: [...] }) }. La query se ignora al buscar la ruta. */
export function fakeTransport(routes: Record<string, Handler> = {}) {
  const sockets: FakeSocket[] = [];
  const calls: HttpRequest[] = [];
  const transport: Transport = {
    kind: "web",
    request: vi.fn(async (request: HttpRequest) => {
      calls.push(request);
      const key = `${request.method} ${request.path.split("?", 1)[0]}`;
      const handler = routes[key];
      if (!handler) return { status: 500, body: { detail: `Sin ruta falsa para ${key}` } };
      const result = await handler(request);
      return { status: result.status ?? 200, body: result.body ?? null };
    }),
    openSocket: vi.fn((path: string) => {
      const socket = new FakeSocket(path);
      sockets.push(socket);
      return socket;
    }),
  };
  return { transport, sockets, calls, lastSocket: () => sockets[sockets.length - 1] };
}

export const ANA: SessionUser = { id: "ana", name: "Ana Gómez" };

export function makeBoard(over: Partial<Board> = {}): Board {
  return {
    id: "b1",
    name: "Ideas del sprint",
    owner_id: "ana",
    my_role: "owner",
    member_count: 2,
    created_at: "2026-10-20T12:00:00Z",
    updated_at: "2026-10-25T12:00:00Z",
    ...over,
  };
}

function TestLink({ href, children, ...rest }: NavLinkProps) {
  return (
    <a href={href} {...rest}>
      {children}
    </a>
  );
}

export function fakeNavigation(): Navigation {
  return { Link: TestLink, push: vi.fn(), replace: vi.fn(), refresh: vi.fn() };
}

interface ProviderOptions {
  transport?: Transport;
  user?: SessionUser;
  config?: ClientConfig;
  navigation?: Navigation;
  onUnauthorized?: () => void;
}

export function Providers({ children, ...options }: ProviderOptions & { children: ReactNode }) {
  return (
    <NavigationProvider value={options.navigation ?? fakeNavigation()}>
      <AppProvider
        transport={options.transport ?? fakeTransport().transport}
        user={options.user ?? ANA}
        config={options.config ?? { pixelsUrl: null }}
        onUnauthorized={options.onUnauthorized ?? (() => {})}
      >
        {children}
      </AppProvider>
    </NavigationProvider>
  );
}

export function renderWithProviders(ui: ReactElement, options: ProviderOptions = {}): RenderResult {
  return render(<Providers {...options}>{ui}</Providers>);
}

/** JWT sin firma válida: el cliente solo lee su contenido. */
export function fakeJwt(payload: Record<string, unknown>): string {
  const b64 = (value: unknown) => {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    return btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(""))
      .replace(/=+$/, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
  };
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}.firma`;
}
