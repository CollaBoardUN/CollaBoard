/**
 * Mensajes del WebSocket de tiempo real. Reflejan lo que habla el backend
 * (backend/app/routers/ws.py y docs/TIEMPO_REAL.md).
 */
import type { CanvasElement } from "../domain/models/canvas";
import type { Role } from "../lib/types";

/** Una conexión abierta (un usuario con dos pestañas aparece dos veces). */
export interface Peer {
  conn: string;
  user_id: string;
  name: string;
  color: string;
  role: Role;
}

/** Campos que un `update` puede cambiar. `null` borra un campo opcional. */
export type ElementPatch = {
  [K in Exclude<keyof CanvasElement, "id" | "type" | "authorId">]?: CanvasElement[K] | null;
};

export type ElementOp =
  | { op: "add"; element: CanvasElement }
  | { op: "update"; id: string; patch: ElementPatch }
  | { op: "delete"; id: string };

export interface SyncMessage {
  type: "sync";
  seq: number;
  you: Peer;
  elements: CanvasElement[];
  peers: Peer[];
}

export interface OpsMessage {
  type: "ops";
  seq: number;
  conn: string;
  user_id: string;
  ops: ElementOp[];
}

export type ServerMessage =
  | SyncMessage
  | OpsMessage
  | { type: "ack"; ref: number; seq: number | null }
  | { type: "presence"; peers: Peer[] }
  | { type: "cursor"; conn: string; x: number; y: number }
  | { type: "draft"; conn: string; element: CanvasElement | null }
  | { type: "error"; code: string; message: string }
  | { type: "pong" };

export type ClientMessage =
  | { type: "ops"; ref: number; ops: ElementOp[] }
  | { type: "cursor"; x: number; y: number }
  | { type: "draft"; element: CanvasElement | null }
  | { type: "resync" }
  | { type: "ping" };

/** Códigos de cierre del servidor tras los cuales NO tiene sentido reintentar. */
export const CLOSE_UNAUTHORIZED = 4401;
export const CLOSE_FORBIDDEN = 4403;
