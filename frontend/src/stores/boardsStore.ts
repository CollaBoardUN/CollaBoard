/** Estado global de "mis tableros". Lo usa el dashboard y cualquier otra vista. */
import { create } from "zustand";

import { boardsApi } from "../lib/boardsApi";
import type { Board } from "../lib/types";

interface BoardsState {
  boards: Board[];
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  load: () => Promise<void>;
  create: (name: string) => Promise<Board>;
  rename: (id: string, name: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  leave: (id: string, userId: string) => Promise<void>;
  reset: () => void;
}

const byUpdated = (a: Board, b: Board) => b.updated_at.localeCompare(a.updated_at);

export const useBoards = create<BoardsState>((set, get) => ({
  boards: [],
  status: "idle",
  error: null,

  load: async () => {
    set({ status: get().boards.length ? "ready" : "loading", error: null });
    try {
      const boards = await boardsApi.list();
      set({ boards, status: "ready" });
    } catch (e) {
      set({ status: "error", error: (e as Error).message });
    }
  },

  create: async (name) => {
    const board = await boardsApi.create(name);
    set({ boards: [board, ...get().boards] });
    return board;
  },

  rename: async (id, name) => {
    const updated = await boardsApi.rename(id, name);
    set({ boards: get().boards.map((b) => (b.id === id ? updated : b)).sort(byUpdated) });
  },

  remove: async (id) => {
    await boardsApi.remove(id);
    set({ boards: get().boards.filter((b) => b.id !== id) });
  },

  leave: async (id, userId) => {
    await boardsApi.removeMember(id, userId);
    set({ boards: get().boards.filter((b) => b.id !== id) });
  },

  reset: () => set({ boards: [], status: "idle", error: null }),
}));
