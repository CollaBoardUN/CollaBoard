/**
 * Chat por tablero (Chat API, Java). Contrato en docs/p2/CONTRATOS_WEB.md.
 *
 * - Escritura solo por HTTP (POST), con `client_message_id` para que un reenvío
 *   no duplique el mensaje.
 * - Lectura paginada por cursor (`before`) y recuperación de lo nuevo (`after`).
 * - El WebSocket solo entrega mensajes confirmados por el servidor.
 */

export const CHAT_MAX_LENGTH = 2000;
export const CHAT_PAGE_SIZE = 30;

export interface ChatMessage {
  id: string;
  board_id: string;
  sender_id: string;
  sender_name: string;
  text: string;
  client_message_id: string;
  /** ISO 8601 en UTC. */
  created_at: string;
}

/** Una página del historial, en orden cronológico (antiguo -> reciente). */
export interface ChatPage {
  items: ChatMessage[];
  /** Cursor para pedir mensajes más antiguos; `null` si no hay más. */
  next_cursor: string | null;
}

export interface SendChatMessage {
  text: string;
  client_message_id: string;
}

export interface ChatReadReceipt {
  board_id: string;
  user_id: string;
  user_name: string;
  message_id: string;
  message_created_at: string;
  read_at: string;
}

export type ChatServerMessage =
  | { type: "read"; receipt: ChatReadReceipt }
  | { type: "receipts"; receipts: ChatReadReceipt[] }
  | { type: "message"; message: ChatMessage }
  | { type: "error"; code: string; message: string }
  | { type: "pong" };

export type ChatClientMessage = { type: "ping" };

/** Normaliza y valida el texto antes de enviarlo. Devuelve el error a mostrar, o null. */
export function validateChatText(raw: string): string | null {
  const text = raw.trim();
  if (!text) return "Escribe un mensaje";
  if (text.length > CHAT_MAX_LENGTH) return `Máximo ${CHAT_MAX_LENGTH} caracteres`;
  return null;
}

/** Orden total y estable: fecha y, a igualdad, id. */
export function compareMessages(a: ChatMessage, b: ChatMessage): number {
  const byDate = Date.parse(a.created_at) - Date.parse(b.created_at);
  if (byDate !== 0 && !Number.isNaN(byDate)) return byDate;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
