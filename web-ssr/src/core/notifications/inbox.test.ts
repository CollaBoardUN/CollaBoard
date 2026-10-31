import { vi } from "vitest";

import { fakeTransport } from "@/test/fakes";
import { createApis } from "../api";
import type { AppNotification } from "../domain/notifications";
import { createApiClient } from "../transport/apiClient";
import { createInboxStore, InboxController } from "./inbox";

const note = (id: string, over: Partial<AppNotification> = {}): AppNotification => ({
  id,
  type: "chat.message.created",
  board_id: "b1",
  actor_id: "beto",
  payload: { actor_name: "Beto", board_name: "Ideas" },
  created_at: "2026-10-25T10:00:00Z",
  read_at: null,
  ...over,
});

function setup(routes: Parameters<typeof fakeTransport>[0]) {
  const fake = fakeTransport(routes);
  const store = createInboxStore();
  const controller = new InboxController({ apis: createApis(createApiClient(fake.transport)), store });
  return { ...fake, store, controller };
}

describe("bandeja", () => {
  it("carga la lista con el contador de no leídas", async () => {
    const { controller, store } = setup({
      "GET /api/notifications": () => ({ body: { items: [note("n1"), note("n2", { read_at: "x" })], unread_count: 1 } }),
    });
    await controller.refresh();
    expect(store.getState()).toMatchObject({ status: "ready", unread: 1 });
    expect(store.getState().items).toHaveLength(2);
  });

  it("marcar como leída es optimista y usa la respuesta del servidor", async () => {
    const markRead = vi.fn(() => ({ body: note("n1", { read_at: "2026-10-25T11:00:00Z" }) }));
    const { controller, store } = setup({
      "GET /api/notifications": () => ({ body: { items: [note("n1")], unread_count: 1 } }),
      "PATCH /api/notifications/n1/read": markRead,
    });
    await controller.refresh();
    await controller.markRead("n1");
    expect(markRead).toHaveBeenCalledOnce();
    expect(store.getState().unread).toBe(0);
    expect(store.getState().items[0].read_at).toBe("2026-10-25T11:00:00Z");
  });

  it("revierte si el servidor rechaza la lectura", async () => {
    const { controller, store } = setup({
      "GET /api/notifications": () => ({ body: { items: [note("n1")], unread_count: 1 } }),
      "PATCH /api/notifications/n1/read": () => ({ status: 404, body: { detail: "Notificación no encontrada" } }),
    });
    await controller.refresh();
    await expect(controller.markRead("n1")).rejects.toThrow(/No se pudo/);
    expect(store.getState().unread).toBe(1);
    expect(store.getState().items[0].read_at).toBeNull();
  });

  it("si la NotificationAPI no responde, lo indica sin borrar lo que ya había", async () => {
    let up = true;
    const { controller, store } = setup({
      "GET /api/notifications": () => (up ? { body: { items: [note("n1")], unread_count: 1 } } : { status: 0 }),
    });
    await controller.refresh();
    up = false;
    await controller.refresh();
    expect(store.getState().status).toBe("unavailable");
    expect(store.getState().error).toMatch(/no está disponible/);
    expect(store.getState().items).toHaveLength(1);
  });
});
