/**
 * Bandeja de notificaciones: estado por instancia y sondeo REST periódico.
 *
 * El plan P2 pide consultar NotificationDB por REST con refresco periódico (sin
 * otro WebSocket). Marcar como leída es optimista y se revierte si el servidor
 * lo rechaza. Si la NotificationAPI no responde, la bandeja lo indica sin
 * afectar al resto de la página.
 */
import { createStore, type StoreApi } from "zustand/vanilla";

import type { Apis } from "../api";
import type { AppNotification, NotificationList } from "../domain/notifications";
import { ApiError } from "../transport/apiClient";

export interface InboxState {
  items: AppNotification[];
  unread: number;
  status: "idle" | "ready" | "unavailable";
  error: string | null;
}

export interface InboxActions {
  setList: (list: NotificationList) => void;
  setUnavailable: (message: string) => void;
  /** Marca localmente; devuelve la notificación anterior para poder revertir. */
  markReadLocal: (id: string, readAt: string) => AppNotification | null;
  replace: (notification: AppNotification) => void;
}

export type InboxStore = StoreApi<InboxState & InboxActions>;

const countUnread = (items: AppNotification[]) => items.filter((n) => !n.read_at).length;

export function createInboxStore(initial?: NotificationList | null): InboxStore {
  return createStore<InboxState & InboxActions>((set, get) => ({
    items: initial?.items ?? [],
    unread: initial?.unread_count ?? 0,
    status: initial ? "ready" : "idle",
    error: null,

    setList: (list) => set({ items: list.items, unread: list.unread_count, status: "ready", error: null }),
    setUnavailable: (error) => set({ status: "unavailable", error }),
    markReadLocal: (id, readAt) => {
      const previous = get().items.find((n) => n.id === id) ?? null;
      if (!previous || previous.read_at) return previous;
      set((state) => ({
        items: state.items.map((n) => (n.id === id ? { ...n, read_at: readAt } : n)),
        unread: Math.max(0, state.unread - 1),
      }));
      return previous;
    },
    replace: (notification) =>
      set((state) => {
        const items = state.items.map((n) => (n.id === notification.id ? notification : n));
        const delta = countUnread(items) - countUnread(state.items);
        return { items, unread: Math.max(0, state.unread + delta) };
      }),
  }));
}

export interface InboxControllerOptions {
  apis: Pick<Apis, "notifications">;
  store: InboxStore;
  pollEveryMs?: number;
}

export class InboxController {
  private timer: ReturnType<typeof setInterval> | undefined;
  private inFlight: AbortController | null = null;

  constructor(private readonly options: InboxControllerOptions) {}

  start(): void {
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.options.pollEveryMs ?? 15_000);
    globalThis.document?.addEventListener("visibilitychange", this.onVisibility);
  }

  stop(): void {
    clearInterval(this.timer);
    this.inFlight?.abort();
    globalThis.document?.removeEventListener("visibilitychange", this.onVisibility);
  }

  async refresh(): Promise<void> {
    if (globalThis.document?.visibilityState === "hidden") return;
    this.inFlight?.abort();
    const controller = new AbortController();
    this.inFlight = controller;
    try {
      const list = await this.options.apis.notifications.list({}, controller.signal);
      if (!controller.signal.aborted) this.options.store.getState().setList(list);
    } catch (error) {
      if (controller.signal.aborted) return;
      this.options.store.getState().setUnavailable(
        error instanceof ApiError && error.status !== 0 ? error.message : "La bandeja no está disponible ahora",
      );
    }
  }

  async markRead(id: string): Promise<void> {
    const store = this.options.store.getState();
    const previous = store.markReadLocal(id, new Date().toISOString());
    if (!previous || previous.read_at) return;
    try {
      store.replace(await this.options.apis.notifications.markRead(id));
    } catch {
      store.replace(previous);
      throw new Error("No se pudo marcar como leída");
    }
  }

  private readonly onVisibility = (): void => {
    if (globalThis.document?.visibilityState === "visible") void this.refresh();
  };
}
