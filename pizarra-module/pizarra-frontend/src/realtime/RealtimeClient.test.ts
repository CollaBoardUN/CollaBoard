import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CanvasElement } from "../domain/models/canvas";
import { RealtimeClient, type RealtimeHandlers, type RealtimeStatus } from "./RealtimeClient";
import type { Peer } from "./protocol";

class FakeSocket {
  static instances: FakeSocket[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = FakeSocket.CONNECTING;
  sent: Record<string, unknown>[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(JSON.parse(data));
  }

  close() {
    this.readyState = FakeSocket.CLOSED;
  }

  // --- ayudas de prueba
  open() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }
  receive(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  drop(code = 1006) {
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.({ code });
  }
  sentOfType(type: string) {
    return this.sent.filter((m) => m.type === type);
  }
}

const peer: Peer = { conn: "me", user_id: "ana", name: "Ana", color: "#000", role: "editor" };
const el = (id: string): CanvasElement => ({
  id,
  type: "rectangle",
  x: 0,
  y: 0,
  width: 5,
  height: 5,
  fillColor: "#fff",
  strokeColor: "#000",
  strokeWidth: 1,
  authorId: "ana",
});
const sync = (seq = 0, elements: CanvasElement[] = []) => ({
  type: "sync",
  seq,
  you: peer,
  elements,
  peers: [peer],
});
const opsMsg = (seq: number, id: string) => ({
  type: "ops",
  seq,
  conn: "other",
  user_id: "beto",
  ops: [{ op: "add", element: el(id) }],
});

function setup() {
  const statuses: RealtimeStatus[] = [];
  const handlers: RealtimeHandlers = {
    onStatus: (s) => statuses.push(s),
    onSync: vi.fn(),
    onOps: vi.fn(),
    onPresence: vi.fn(),
    onCursor: vi.fn(),
    onDraft: vi.fn(),
    onForbidden: vi.fn(),
  };
  const client = new RealtimeClient({ url: () => "ws://test/ws/boards/b1?token=t", handlers });
  client.connect();
  const socket = () => FakeSocket.instances[FakeSocket.instances.length - 1];
  return { client, handlers, statuses, socket };
}

beforeEach(() => {
  FakeSocket.instances = [];
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", FakeSocket);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("RealtimeClient", () => {
  it("pasa a online al recibir el sync y entrega el estado", () => {
    const { handlers, statuses, socket } = setup();
    socket().open();
    socket().receive(sync(3, [el("a")]));
    expect(statuses).toEqual(["connecting", "online"]);
    expect(handlers.onSync).toHaveBeenCalledWith(expect.objectContaining({ seq: 3 }));
  });

  it("aplica los lotes en orden y descarta repetidos", () => {
    const { handlers, socket } = setup();
    socket().open();
    socket().receive(sync(0));
    socket().receive(opsMsg(1, "a"));
    socket().receive(opsMsg(1, "a"));
    socket().receive(opsMsg(2, "b"));
    expect(handlers.onOps).toHaveBeenCalledTimes(2);
  });

  it("ante un hueco en la secuencia pide resync y descarta lo siguiente hasta recibirlo", () => {
    const { handlers, socket } = setup();
    socket().open();
    socket().receive(sync(0));
    socket().receive(opsMsg(3, "c")); // faltan 1 y 2
    expect(socket().sentOfType("resync")).toHaveLength(1);
    socket().receive(opsMsg(4, "d"));
    expect(handlers.onOps).not.toHaveBeenCalled();

    socket().receive(sync(4, [el("a"), el("b"), el("c"), el("d")]));
    socket().receive(opsMsg(5, "e"));
    expect(handlers.onOps).toHaveBeenCalledTimes(1);
  });

  it("envía las operaciones con una referencia y deja de reenviarlas tras el ack", () => {
    const { client, socket } = setup();
    socket().open();
    socket().receive(sync(0));
    client.sendOps([{ op: "add", element: el("a") }]);
    const [batch] = socket().sentOfType("ops");
    expect(batch).toMatchObject({ ref: 1 });

    socket().receive({ type: "ack", ref: 1, seq: 1 });
    socket().drop();
    vi.advanceTimersByTime(11_000);
    socket().open();
    socket().receive(sync(1));
    expect(socket().sentOfType("ops")).toHaveLength(0);
  });

  it("reconecta con espera creciente y reenvía lo no confirmado", () => {
    const { client, statuses, socket } = setup();
    socket().open();
    socket().receive(sync(0));
    client.sendOps([{ op: "add", element: el("a") }]); // sin ack: se perdió con la caída

    socket().drop();
    expect(statuses.at(-1)).toBe("reconnecting");
    expect(FakeSocket.instances).toHaveLength(1);

    vi.advanceTimersByTime(1_000);
    expect(FakeSocket.instances).toHaveLength(2);
    socket().open();
    socket().receive(sync(0));
    expect(statuses.at(-1)).toBe("online");
    expect(socket().sentOfType("ops")).toHaveLength(1);
  });

  it("guarda en cola lo dibujado sin conexión y lo envía tras el sync", () => {
    const { client, socket } = setup();
    client.sendOps([{ op: "add", element: el("offline") }]);
    socket().open();
    expect(socket().sentOfType("ops")).toHaveLength(0);
    socket().receive(sync(0));
    expect(socket().sentOfType("ops")).toHaveLength(1);
  });

  it("no reintenta si el servidor niega el acceso", () => {
    const { statuses, socket } = setup();
    socket().drop(4403);
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.instances).toHaveLength(1);
    expect(statuses.at(-1)).toBe("denied");
  });

  it("al recibir 'forbidden' avisa, vacía la cola y pide el estado real", () => {
    const { client, handlers, socket } = setup();
    socket().open();
    socket().receive(sync(0));
    client.sendOps([{ op: "add", element: el("a") }]);
    socket().receive({ type: "error", code: "forbidden", message: "x" });
    expect(handlers.onForbidden).toHaveBeenCalled();
    expect(socket().sentOfType("resync")).toHaveLength(1);
  });

  it("no envía cursores ni trazos hasta estar sincronizado", () => {
    const { client, socket } = setup();
    socket().open();
    client.sendCursor(1, 2);
    client.sendDraft(el("d"));
    expect(socket().sent).toEqual([]);
    socket().receive(sync(0));
    client.sendCursor(1, 2);
    expect(socket().sentOfType("cursor")).toHaveLength(1);
  });

  it("close() cancela la reconexión", () => {
    const { client, socket } = setup();
    socket().open();
    socket().receive(sync(0));
    socket().drop();
    client.close();
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.instances).toHaveLength(1);
  });
});
