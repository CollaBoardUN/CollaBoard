/**
 * Estado efímero del tiempo real: conexión, quién está conectado, cursores y
 * trazos en curso de los demás. Los elementos del tablero viven en
 * `useBoardStore`; esto es solo lo que no se guarda.
 */
import { create } from "zustand";

import type { CanvasElement } from "@/core/domain/canvas";
import type { RealtimeStatus } from "./RealtimeClient";
import type { Peer } from "./protocol";

export interface RemoteCursor {
  x: number;
  y: number;
}

/** Estado del guardado automático tal como lo informa Pizarra (`saved` / `save_error`). */
export interface SaveState {
  status: "unknown" | "saved" | "error";
  savedAt: string | null;
  seq: number | null;
}

interface RealtimeState {
  status: RealtimeStatus;
  /** Id de MI conexión (el servidor lo manda en el `sync`). */
  selfConn: string | null;
  peers: Peer[];
  cursors: Record<string, RemoteCursor>;
  drafts: Record<string, CanvasElement>;
  /** Trazo que estoy dibujando ahora mismo; el canvas lo publica y el hook lo envía. */
  localDraft: CanvasElement | null;
  save: SaveState;
  setStatus: (status: RealtimeStatus) => void;
  setSelfConn: (conn: string | null) => void;
  setPeers: (peers: Peer[]) => void;
  setCursor: (conn: string, cursor: RemoteCursor) => void;
  setDraft: (conn: string, element: CanvasElement | null) => void;
  setLocalDraft: (element: CanvasElement | null) => void;
  setSaved: (seq: number, savedAt: string) => void;
  setSaveError: () => void;
  /** Estado inicial del guardado, p. ej. el `saved_at` renderizado en el servidor. */
  seedSave: (savedAt: string | null, seq: number | null) => void;
  reset: () => void;
}

const initial = {
  status: "connecting" as RealtimeStatus,
  selfConn: null,
  peers: [] as Peer[],
  cursors: {} as Record<string, RemoteCursor>,
  drafts: {} as Record<string, CanvasElement>,
  localDraft: null,
  save: { status: "unknown", savedAt: null, seq: null } as SaveState,
};

const keepOnly = <T>(record: Record<string, T>, conns: Set<string>): Record<string, T> =>
  Object.fromEntries(Object.entries(record).filter(([conn]) => conns.has(conn)));

export const useRealtime = create<RealtimeState>((set) => ({
  ...initial,
  setStatus: (status) => set({ status }),
  setSelfConn: (selfConn) => set({ selfConn }),
  setPeers: (peers) =>
    set((state) => {
      // Quien se fue ya no tiene cursor ni trazo en pantalla.
      const conns = new Set(peers.map((peer) => peer.conn));
      return {
        peers,
        cursors: keepOnly(state.cursors, conns),
        drafts: keepOnly(state.drafts, conns),
      };
    }),
  setCursor: (conn, cursor) => set((state) => ({ cursors: { ...state.cursors, [conn]: cursor } })),
  setDraft: (conn, element) =>
    set((state) => {
      const drafts = { ...state.drafts };
      if (element) drafts[conn] = element;
      else delete drafts[conn];
      return { drafts };
    }),
  setLocalDraft: (localDraft) => set({ localDraft }),
  setSaved: (seq, savedAt) => set({ save: { status: "saved", savedAt, seq } }),
  setSaveError: () => set((state) => ({ save: { ...state.save, status: "error" } })),
  seedSave: (savedAt, seq) =>
    set({ save: { status: savedAt ? "saved" : "unknown", savedAt, seq } }),
  reset: () => set({ ...initial }),
}));
