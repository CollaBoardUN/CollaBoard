/**
 * Bandeja de notificaciones (NotificationAPI, C#). Contrato en docs/p2/CONTRATOS_WEB.md.
 *
 * El trabajador crea las notificaciones a partir de eventos `invite.accepted` y
 * `chat.message.created`; la bandeja solo las consulta y marca como leídas.
 */

export type NotificationType = "invite.accepted" | "chat.message.created";

export interface NotificationPayload {
  board_name?: string;
  actor_name?: string;
  role?: string;
  preview?: string;
}

export interface AppNotification {
  id: string;
  type: NotificationType | (string & {});
  board_id: string | null;
  actor_id: string | null;
  payload: NotificationPayload;
  /** ISO 8601 en UTC. */
  created_at: string;
  read_at: string | null;
}

export interface NotificationList {
  items: AppNotification[];
  unread_count: number;
}

export interface NotificationText {
  title: string;
  body: string;
}

const PREVIEW_MAX = 90;

function clip(text: string, max = PREVIEW_MAX): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Texto legible de una notificación. Tolera tipos nuevos y payloads incompletos. */
export function describeNotification(n: AppNotification): NotificationText {
  const actor = n.payload.actor_name?.trim() || "Alguien";
  const board = n.payload.board_name?.trim() || "un tablero";
  switch (n.type) {
    case "invite.accepted":
      return { title: `${actor} se unió a ${board}`, body: "Aceptó tu invitación." };
    case "chat.message.created":
      return {
        title: `${actor} escribió en ${board}`,
        body: n.payload.preview ? clip(n.payload.preview) : "Nuevo mensaje en el chat.",
      };
    default:
      return { title: "Nueva notificación", body: board };
  }
}
