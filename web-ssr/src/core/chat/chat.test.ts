import { afterEach, beforeEach, vi } from "vitest";

import { fakeTransport } from "@/test/fakes";
import { createApis } from "../api";
import type { ChatMessage, ChatPage } from "../domain/chat";
import { createApiClient } from "../transport/apiClient";
import { ChatController, CHAT_CLOSE_FORBIDDEN } from "./ChatController";
import { createChatStore, mergeMessages } from "./chatStore";

const msg = (id: string, over: Partial<ChatMessage> = {}): ChatMessage => ({
  id,
  board_id: "b1",
  sender_id: "beto",
  sender_name: "Beto",
  text: `texto ${id}`,
  client_message_id: `c-${id}`,
  created_at: `2026-10-25T10:00:0${id.replace(/\D/g, "") || 0}Z`,
  ...over,
});

describe("chatStore", () => {
  it("fusiona sin duplicar y en orden cronológico", () => {
    const merged = mergeMessages([msg("m2")], [msg("m1"), msg("m2"), msg("m3")]);
    expect(merged.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
    const same = [msg("m1")];
    expect(mergeMessages(same, [same[0]])).toBe(same);
  });

  it("al confirmar un mensaje propio quita su versión pendiente", () => {
    const store = createChatStore();
    store.getState().addPending({ client_message_id: "c-x", text: "hola", created_at: "", status: "sending" });
    store.getState().receive([msg("m1", { client_message_id: "c-x", sender_id: "ana" })]);
    expect(store.getState().pending).toEqual([]);
    expect(store.getState().messages).toHaveLength(1);
  });

  it("antepone páginas antiguas y actualiza el cursor", () => {
    const store = createChatStore({ items: [msg("m3"), msg("m4")], next_cursor: "m3" });
    store.getState().prependOlder({ items: [msg("m1"), msg("m2")], next_cursor: null });
    expect(store.getState().messages.map((m) => m.id)).toEqual(["m1", "m2", "m3", "m4"]);
    expect(store.getState().nextCursor).toBeNull();
  });
});

describe("ChatController", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup(routes: Parameters<typeof fakeTransport>[0], initial?: ChatPage) {
    const fake = fakeTransport(routes);
    const store = createChatStore(initial);
    const apis = createApis(createApiClient(fake.transport));
    const controller = new ChatController({ boardId: "b1", apis, transport: fake.transport, store, pollEveryMs: 1000 });
    return { ...fake, store, controller };
  }

  it("envía por HTTP con client_message_id y reutiliza el mismo id al reintentar", async () => {
    let attempt = 0;
    const { controller, store, calls } = setup(
      {
        "GET /api/chat/boards/b1/messages": () => ({ body: { items: [], next_cursor: null } }),
        "POST /api/chat/boards/b1/messages": (req) => {
          attempt += 1;
          if (attempt === 1) return { status: 0 };
          const body = req.body as { text: string; client_message_id: string };
          return { status: 201, body: msg("m9", { ...body, sender_id: "ana" }) };
        },
      },
      { items: [], next_cursor: null },
    );
    controller.start();

    expect(controller.send("   ")).toBe("Escribe un mensaje");
    expect(controller.send("Hola")).toBeNull();
    await vi.runOnlyPendingTimersAsync();
    const [pending] = store.getState().pending;
    expect(pending.status).toBe("failed");
    expect(pending.error).toMatch(/Sin conexión/);

    controller.retry(pending.client_message_id);
    await vi.runOnlyPendingTimersAsync();
    const posts = calls.filter((c) => c.method === "POST").map((c) => (c.body as { client_message_id: string }).client_message_id);
    expect(posts).toHaveLength(2);
    expect(posts[0]).toBe(posts[1]);
    expect(store.getState().pending).toEqual([]);
    expect(store.getState().messages.map((m) => m.text)).toEqual(["Hola"]);
    controller.stop();
  });

  it("al abrir el socket recupera lo nuevo con ?after= y luego recibe en vivo", async () => {
    const { controller, store, lastSocket, calls } = setup(
      {
        "GET /api/chat/boards/b1/messages": (req) =>
          req.path.includes("after=m1")
            ? { body: { items: [msg("m2")], next_cursor: null } }
            : { body: { items: [msg("m1")], next_cursor: null } },
      },
      { items: [msg("m1")], next_cursor: null },
    );
    controller.start();
    expect(lastSocket().path).toBe("/ws/chat/boards/b1");
    lastSocket().open();
    await vi.runOnlyPendingTimersAsync();
    expect(calls.some((c) => c.path.includes("after=m1"))).toBe(true);
    expect(store.getState().live).toBe("online");

    lastSocket().receive({ type: "message", message: msg("m3") });
    lastSocket().receive({ type: "message", message: msg("m4", { board_id: "otro" }) }); // de otro tablero: se ignora
    expect(store.getState().messages.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
    controller.stop();
  });

  it("si el socket cae, sondea por HTTP y reintenta conectar", async () => {
    const { controller, store, sockets, lastSocket } = setup(
      { "GET /api/chat/boards/b1/messages": () => ({ body: { items: [msg("m1")], next_cursor: null } }) },
      { items: [], next_cursor: null },
    );
    controller.start();
    lastSocket().open();
    lastSocket().drop(1006);
    expect(store.getState().live).toBe("polling");
    await vi.advanceTimersByTimeAsync(1100);
    expect(store.getState().messages).toHaveLength(1); // llegó por sondeo
    await vi.advanceTimersByTimeAsync(2000);
    expect(sockets.length).toBeGreaterThan(1); // reintentó el WebSocket
    controller.stop();
  });

  it("un cierre 4403 (sin acceso) detiene el chat en vivo", () => {
    const { controller, store, sockets, lastSocket } = setup({}, { items: [], next_cursor: null });
    controller.start();
    lastSocket().drop(CHAT_CLOSE_FORBIDDEN);
    vi.advanceTimersByTime(60_000);
    expect(store.getState().live).toBe("denied");
    expect(sockets).toHaveLength(1);
    controller.stop();
  });

  it("carga páginas anteriores con el cursor", async () => {
    const { controller, store } = setup(
      {
        "GET /api/chat/boards/b1/messages": (req) =>
          req.path.includes("before=m3")
            ? { body: { items: [msg("m1"), msg("m2")], next_cursor: null } }
            : { body: { items: [], next_cursor: null } },
      },
      { items: [msg("m3")], next_cursor: "m3" },
    );
    await controller.loadOlder();
    expect(store.getState().messages.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
  });
});
