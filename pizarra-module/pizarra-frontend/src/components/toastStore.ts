import { create } from "zustand";

export interface ToastItem {
  id: number;
  message: string;
  tone: "ok" | "error";
}

interface ToastState {
  items: ToastItem[];
  show: (message: string, tone?: ToastItem["tone"]) => void;
  dismiss: (id: number) => void;
}

let nextId = 1;

export const useToast = create<ToastState>((set, get) => ({
  items: [],
  show: (message, tone = "ok") => {
    const id = nextId++;
    set({ items: [...get().items, { id, message, tone }] });
    setTimeout(() => get().dismiss(id), 4000);
  },
  dismiss: (id) => set({ items: get().items.filter((t) => t.id !== id) }),
}));

export const toast = {
  ok: (message: string) => useToast.getState().show(message, "ok"),
  error: (message: string) => useToast.getState().show(message, "error"),
};
