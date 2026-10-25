/**
 * Estado del chat de UN tablero. Es una fábrica (no un store global) para que
 * cada panel tenga el suyo: en el servidor no se comparte estado entre
 * peticiones y dos tableros abiertos no mezclan mensajes.
 */
import { createStore, type StoreApi } from "zustand/vanilla";

import { compareMessages, type ChatMessage, type ChatPage } from "../domain/chat";

export type LiveStatus = "connecting" | "online" | "polling" | "denied" | "closed";

/** Mensaje propio aún no confirmado por el servidor. */
export interface PendingMessage {
  client_message_id: string;
  text: string;
  created_at: string;
  status: "sending" | "failed";
  error?: string;
}

export interface ChatState {
  messages: ChatMessage[];
  pending: PendingMessage[];
  nextCursor: string | null;
  history: "idle" | "loading" | "ready" | "error";
  historyError: string | null;
  loadingOlder: boolean;
  live: LiveStatus;
}

export interface ChatActions {
  setHistoryLoading: () => void;
  setHistoryError: (message: string) => void;
  /** Primera página (o recarga completa). */
  setPage: (page: ChatPage) => void;
  setLoadingOlder: (loading: boolean) => void;
  /** Página más antigua obtenida con el cursor. */
  prependOlder: (page: ChatPage) => void;
  /** Mensajes confirmados (WS, sondeo o respuesta del POST). Idempotente. */
  receive: (messages: ChatMessage[]) => void;
  addPending: (message: PendingMessage) => void;
  failPending: (clientMessageId: string, error: string) => void;
  retryPending: (clientMessageId: string) => PendingMessage | null;
  discardPending: (clientMessageId: string) => void;
  setLive: (live: LiveStatus) => void;
}

export type ChatStore = StoreApi<ChatState & ChatActions>;

/** Une listas de mensajes sin duplicados (por `id`) y en orden cronológico. */
export function mergeMessages(current: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  if (incoming.length === 0) return current;
  const byId = new Map(current.map((m) => [m.id, m]));
  let changed = false;
  for (const message of incoming) {
    if (!byId.has(message.id)) changed = true;
    byId.set(message.id, message);
  }
  if (!changed) return current;
  return [...byId.values()].sort(compareMessages);
}

export function createChatStore(initial?: ChatPage | null): ChatStore {
  return createStore<ChatState & ChatActions>((set, get) => ({
    messages: initial ? [...initial.items].sort(compareMessages) : [],
    pending: [],
    nextCursor: initial?.next_cursor ?? null,
    history: initial ? "ready" : "idle",
    historyError: null,
    loadingOlder: false,
    live: "connecting",

    setHistoryLoading: () => set({ history: "loading", historyError: null }),
    setHistoryError: (historyError) => set({ history: "error", historyError }),
    setPage: (page) =>
      set((state) => ({
        messages: mergeMessages(state.messages, page.items),
        nextCursor: page.next_cursor,
        history: "ready",
        historyError: null,
      })),
    setLoadingOlder: (loadingOlder) => set({ loadingOlder }),
    prependOlder: (page) =>
      set((state) => ({
        messages: mergeMessages(state.messages, page.items),
        nextCursor: page.next_cursor,
        loadingOlder: false,
      })),
    receive: (messages) =>
      set((state) => {
        const confirmed = new Set(messages.map((m) => m.client_message_id));
        return {
          messages: mergeMessages(state.messages, messages),
          pending: state.pending.filter((p) => !confirmed.has(p.client_message_id)),
        };
      }),
    addPending: (message) => set((state) => ({ pending: [...state.pending, message] })),
    failPending: (id, error) =>
      set((state) => ({
        pending: state.pending.map((p) => (p.client_message_id === id ? { ...p, status: "failed", error } : p)),
      })),
    retryPending: (id) => {
      const found = get().pending.find((p) => p.client_message_id === id);
      if (!found) return null;
      const retry: PendingMessage = { ...found, status: "sending", error: undefined };
      set((state) => ({ pending: state.pending.map((p) => (p.client_message_id === id ? retry : p)) }));
      return retry;
    },
    discardPending: (id) => set((state) => ({ pending: state.pending.filter((p) => p.client_message_id !== id) })),
    setLive: (live) => set({ live }),
  }));
}
