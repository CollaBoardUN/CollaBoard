import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CanvasElement } from "@/core/domain/canvas";
import { useBoardStore } from "@/core/stores/useBoardStore";
import type { SocketLike } from "@/core/transport/types";
import { useBoardRealtime } from "@/ui/board/useBoardRealtime";
import { applyOps } from "./elementOps";
import type { ClientMessage, ElementOp, Peer, ServerMessage } from "./protocol";
import { useRealtime } from "./realtimeStore";

const transport = vi.hoisted(() => ({ openSocket: vi.fn() }));
vi.mock("@/ui/AppContext", () => ({ useTransport: () => transport }));

class Socket implements SocketLike {
  readyState = 0;
  sent: ClientMessage[] = [];
  onopen: SocketLike["onopen"] = null;
  onmessage: SocketLike["onmessage"] = null;
  onerror: SocketLike["onerror"] = null;
  onclose: SocketLike["onclose"] = null;
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() { this.readyState = 3; }
  open() { this.readyState = 1; this.onopen?.(); }
  receive(message: ServerMessage) { this.onmessage?.({ data: JSON.stringify(message) }); }
  drop() { this.readyState = 3; this.onclose?.({ code: 1006 }); }
}

const me: Peer = { conn: "tab-1", user_id: "ana", name: "Ana", color: "#000", role: "editor" };
const make = (id: string): CanvasElement => ({
  id, type: "star", x: 0, y: 0, width: 50, height: 50,
  fillColor: "#fff", strokeColor: "#000", strokeWidth: 2, authorId: "ana",
});
const initialStore = useBoardStore.getState();
const store = () => useBoardStore.getState();
const ids = () => store().elements.map((element) => element.id);
const content = (elements: CanvasElement[]) => [...elements].sort((a, b) => a.id.localeCompare(b.id));

/** Servidor simulado: el hook, store, puente y cliente son los de producción. */
function setup(initial: CanvasElement[] = []) {
  const sockets: Socket[] = [];
  transport.openSocket.mockImplementation(() => {
    const socket = new Socket();
    sockets.push(socket);
    return socket;
  });
  const hook = renderHook(() => useBoardRealtime("board"));
  let seq = 0;
  let elements = initial;
  let self = me;
  const socket = () => sockets[sockets.length - 1];
  const sync = (conn = self.conn) => {
    self = { ...me, conn };
    act(() => socket().receive({ type: "sync", seq, elements, you: self, peers: [self] }));
  };
  act(() => socket().open());
  sync();
  const broadcast = (ops: ElementOp[], conn: string, user_id = "beto") => {
    elements = applyOps(elements, ops);
    seq += 1;
    socket().receive({ type: "ops", seq, conn, user_id, ops });
  };
  const local = () => {
    const batch = socket().sent.find((message) => message.type === "ops");
    if (!batch || batch.type !== "ops") throw new Error("No hay lote local pendiente");
    socket().sent.splice(socket().sent.indexOf(batch), 1);
    return batch;
  };
  const confirm = () => {
    const batch = local();
    act(() => {
      broadcast(batch.ops, self.conn, me.user_id);
      socket().receive({ type: "ack", ref: batch.ref, seq });
    });
    return batch;
  };
  const remote = (ops: ElementOp[], conn = "tab-beto", userId = "beto") =>
    act(() => broadcast(ops, conn, userId));
  return { ...hook, socket, sync, confirm, remote, local, broadcast, server: () => elements };
}

beforeEach(() => {
  vi.useFakeTimers();
  useBoardStore.setState(initialStore, true);
  useRealtime.getState().reset();
});
afterEach(() => vi.useRealTimers());

describe("undo/redo de P2 con ecos y reconciliación", () => {
  it("deshace y rehace las estrellas propias conservando las de otra conexión", () => {
    const server = setup();
    act(() => store().addElement(make("a")));
    server.confirm();
    server.remote([{ op: "add", element: make("b") }]);
    act(() => store().addElement(make("c")));
    server.confirm();
    act(() => store().undo());
    server.confirm();
    expect(ids()).toEqual(["a", "b"]);
    act(() => store().undo());
    server.confirm();
    expect(ids()).toEqual(["b"]);
    act(() => store().redo());
    server.confirm();
    expect(ids()).toEqual(["b", "a"]);
    expect(store().elements).toEqual(server.server());
    act(() => store().redo());
    server.confirm();
    expect(ids()).toEqual(["b", "a", "c"]);
  });

  it.each([
    ["texto", () => store().updateElementText("a", "editado")],
    ["movimiento", () => store().updateElementPosition("a", 40, 60)],
    ["geometría", () => store().updateElementGeometry("a", { width: 100, height: 80 })],
    ["estilo", () => { store().setSelectedElementId("a"); store().setActiveFillColor("#ff0000"); }],
    ["borrado", () => store().deleteElement("a")],
    ["limpieza", () => store().clearCanvas()],
  ] as const)("conserva undo/redo de %s después de su eco", (_name, action) => {
    const before = [make("a"), make("b")];
    const server = setup(before);
    act(action);
    const after = content(store().elements);
    server.confirm();
    server.remote([{ op: "add", element: make("ajeno") }]);
    act(() => store().undo());
    server.confirm();
    expect(content(store().elements)).toEqual(content([...before, make("ajeno")]));
    act(() => store().redo());
    server.confirm();
    expect(content(store().elements)).toEqual(content([...after, make("ajeno")]));
    expect(store().elements).toEqual(server.server());
  });

  it("otra pestaña de la misma cuenta es remota y sobrevive al undo", () => {
    const server = setup();
    act(() => store().addElement(make("a")));
    server.confirm();
    server.remote([{ op: "add", element: make("b") }], "tab-2", me.user_id);
    act(() => store().undo());
    server.confirm();
    expect(ids()).toEqual(["b"]);
  });

  it("un eco atrasado no revive lo deshecho ni pisa ediciones pendientes", () => {
    const server = setup();
    act(() => store().addElement(make("a")));
    act(() => store().updateElementPosition("a", 10, 20));
    act(() => store().updateElementPosition("a", 30, 40));
    server.confirm();
    expect(store().elements[0]).toMatchObject({ x: 30, y: 40 });
    server.confirm();
    expect(store().elements[0]).toMatchObject({ x: 30, y: 40 });
    act(() => store().undo());
    server.confirm(); // eco de x=30; el undo a x=10 sigue pendiente
    expect(store().elements[0]).toMatchObject({ x: 10, y: 20 });
    server.confirm();
    expect(store().elements).toEqual(server.server());
  });

  it("undo antes del eco de creación mantiene la figura ausente hasta confirmar ambos lotes", () => {
    const server = setup();
    act(() => store().addElement(make("a")));
    act(() => store().undo());
    server.confirm();
    expect(ids()).toEqual([]);
    server.confirm();
    expect(ids()).toEqual([]);
    act(() => store().redo());
    server.confirm();
    expect(ids()).toEqual(["a"]);
  });

  it("una figura ajena recibida entre undo y redo conserva su posición confirmada", () => {
    const server = setup();
    act(() => store().addElement(make("a")));
    server.confirm();
    act(() => store().undo());
    server.confirm();
    server.remote([{ op: "add", element: make("b") }]);
    act(() => store().redo());
    server.confirm();
    expect(ids()).toEqual(["b", "a"]);
    expect(store().elements).toEqual(server.server());
  });

  it("una acción nueva después de undo descarta redo sin borrar cambios ajenos", () => {
    const server = setup();
    act(() => store().addElement(make("a")));
    server.confirm();
    act(() => store().undo());
    server.confirm();
    server.remote([{ op: "add", element: make("b") }]);
    act(() => store().addElement(make("c")));
    server.confirm();
    act(() => store().redo());
    expect(ids()).toEqual(["b", "c"]);
    expect(server.socket().sent.filter((message) => message.type === "ops")).toHaveLength(0);
  });

  it("permite deshacer una edición pendiente que el servidor ordena después de una ajena", () => {
    const server = setup([make("a")]);
    act(() => store().updateElementPosition("a", 10, 20));
    server.remote([{ op: "update", id: "a", patch: { x: 90, y: 80 } }]);
    expect(store().elements[0]).toMatchObject({ x: 10, y: 20 });
    expect(store().historyStep).toBe(1);
    server.confirm();
    act(() => store().undo());
    server.confirm();
    expect(store().elements[0]).toMatchObject({ x: 90, y: 80 });
  });

  it("reconcilia el orden confirmado cuando otro add precede al mío", () => {
    const server = setup();
    act(() => store().addElement(make("a")));
    server.remote([{ op: "add", element: make("b") }]);
    server.confirm();
    expect(ids()).toEqual(["b", "a"]);
    act(() => store().undo());
    server.confirm();
    expect(ids()).toEqual(["b"]);
    act(() => store().redo());
    server.confirm();
    expect(store().elements).toEqual(server.server());
  });

  it("deshacer un campo propio no sobrescribe otro campo editado remotamente", () => {
    const server = setup([make("a")]);
    act(() => store().updateElementPosition("a", 10, 20));
    server.confirm();
    server.remote([{ op: "update", id: "a", patch: { text: "de Beto" } }]);
    act(() => store().undo());
    server.confirm();
    expect(store().elements[0]).toMatchObject({ x: 0, y: 0, text: "de Beto" });
    act(() => store().redo());
    server.confirm();
    expect(store().elements[0]).toMatchObject({ x: 10, y: 20, text: "de Beto" });
  });

  it("recupera lo dibujado sin conexión y acepta sus ecos bajo la nueva conexión", () => {
    const server = setup();
    act(() => server.socket().drop());
    act(() => store().addElement(make("offline")));
    act(() => vi.advanceTimersByTime(1_000));
    act(() => server.socket().open());
    server.sync("reconnected");
    expect(ids()).toEqual(["offline"]);
    server.confirm();
    expect(store().elements).toEqual(server.server());
    expect(useRealtime.getState().selfConn).toBe("reconnected");
  });

  it("protege la edición ajena de una figura propia sin retener movimientos propios", () => {
    const server = setup();
    act(() => store().addElement(make("a")));
    server.confirm();
    act(() => store().updateElementPosition("a", 10, 20));
    server.confirm();
    server.remote([{ op: "update", id: "a", patch: { text: "trabajo de Beto" } }]);
    act(() => store().undo());
    server.confirm();
    expect(store().elements[0]).toMatchObject({ x: 0, y: 0, text: "trabajo de Beto" });
    expect(store().historyStep).toBe(0);
    act(() => store().undo());
    expect(ids()).toEqual(["a"]);
    expect(server.socket().sent.filter((message) => message.type === "ops")).toHaveLength(0);
  });

  it("un borrado remoto no reaparece y una edición remota del mismo campo prevalece", () => {
    const server = setup([make("a"), make("b")]);
    act(() => store().updateElementPosition("a", 10, 20));
    server.confirm();
    server.remote([{ op: "update", id: "a", patch: { x: 90, y: 80 } }]);
    expect(store().historyStep).toBe(0);
    act(() => store().deleteElement("b"));
    server.confirm();
    server.remote([{ op: "delete", id: "a" }]);
    act(() => store().undo());
    server.confirm();
    expect(ids()).toEqual(["b"]);
  });

  it("un hueco seguido de sync conserva pendientes sin reenviar lotes ya enviados", () => {
    const server = setup();
    act(() => store().addElement(make("a")));
    act(() => server.socket().receive({ type: "ops", seq: 3, conn: "other", user_id: "beto", ops: [] }));
    act(() => store().addElement(make("b")));
    server.sync();
    expect(ids()).toEqual(["a", "b"]);
    expect(server.socket().sent.filter((message) => message.type === "ops")).toHaveLength(2);
    server.confirm();
    server.confirm();
    expect(store().elements).toEqual(server.server());
  });

  it("un eco cubierto por sync no se reenvía aunque se haya perdido su ack", () => {
    const server = setup([make("a")]);
    act(() => store().updateElementText("a", "mío"));
    const batch = server.local();
    act(() => server.broadcast(batch.ops, me.conn, me.user_id));
    server.remote([{ op: "update", id: "a", patch: { text: "posterior de Beto" } }]);
    act(() => server.socket().drop());
    act(() => vi.advanceTimersByTime(1_000));
    act(() => server.socket().open());
    server.sync("reconnected");
    expect(server.socket().sent.filter((message) => message.type === "ops")).toHaveLength(0);
    expect(store().elements[0].text).toBe("posterior de Beto");
  });

  it("un ack adelantado pide sync en vez de retirar la proyección sobre una base incompleta", () => {
    const server = setup();
    act(() => store().addElement(make("a")));
    const batch = server.local();
    act(() => server.socket().receive({ type: "ack", ref: batch.ref, seq: 1 }));
    expect(ids()).toEqual(["a"]);
    expect(server.socket().sent.filter((message) => message.type === "resync")).toHaveLength(1);
    act(() => server.socket().receive({ type: "sync", seq: 1, you: me, peers: [me], elements: [make("a")] }));
    expect(ids()).toEqual(["a"]);
  });

  it("aplica la normalización del eco y retira operaciones rechazadas con ack null", () => {
    const server = setup();
    act(() => store().addElement({ ...make("a"), authorId: "incorrecto" }));
    const batch = server.local();
    act(() => {
      server.broadcast([{ op: "add", element: make("a") }], me.conn, me.user_id);
      server.socket().receive({ type: "ack", ref: batch.ref, seq: 1 });
    });
    expect(store().elements[0].authorId).toBe(me.user_id);
    act(() => store().updateElementText("a", "rechazado"));
    const invalid = server.local();
    act(() => server.socket().receive({ type: "ack", ref: invalid.ref, seq: null }));
    expect(store().elements[0].text).toBeUndefined();
    expect(server.socket().sent.filter((message) => message.type === "ops")).toHaveLength(0);
  });

  it("mantiene separados guardado, confirmación y resincronización por permisos", () => {
    const server = setup();
    act(() => store().addElement(make("a")));
    server.confirm();
    expect(useRealtime.getState().save.status).toBe("unknown");
    act(() => server.socket().receive({ type: "saved", seq: 1, saved_at: "2026-10-27T19:00:00Z" }));
    expect(useRealtime.getState().save.status).toBe("saved");
    act(() => store().addElement(make("rechazado")));
    act(() => server.socket().receive({ type: "error", code: "forbidden", message: "viewer" }));
    server.sync();
    expect(ids()).toEqual(["a"]);
    expect(store().historyStep).toBe(0);
  });
});
