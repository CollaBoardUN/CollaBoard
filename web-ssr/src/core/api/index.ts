/**
 * APIs tipadas por dominio, sobre las rutas públicas del gateway (plan P2, sección 4).
 * Funcionan igual en la web y en Electron porque solo dependen de `ApiClient`.
 */
import type { CanvasState } from "../domain/canvasState";
import type { ChatMessage, ChatPage, SendChatMessage } from "../domain/chat";
import { CHAT_PAGE_SIZE } from "../domain/chat";
import type { AppNotification, NotificationList } from "../domain/notifications";
import type {
  Board,
  Invite,
  InvitePreview,
  JoinResult,
  Member,
  ShareableRole,
} from "../domain/types";
import type { ApiClient } from "../transport/apiClient";

const enc = encodeURIComponent;

function query(params: Record<string, string | number | boolean | null | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

/** Colaboración (Python): tableros, miembros, roles e invitaciones. */
export function boardsApi(api: ApiClient) {
  return {
    list: () => api.get<Board[]>("/api/boards"),
    get: (id: string) => api.get<Board>(`/api/boards/${enc(id)}`),
    create: (name: string) => api.post<Board>("/api/boards", { name }),
    rename: (id: string, name: string) => api.patch<Board>(`/api/boards/${enc(id)}`, { name }),
    remove: (id: string) => api.delete(`/api/boards/${enc(id)}`),

    members: (id: string) => api.get<Member[]>(`/api/boards/${enc(id)}/members`),
    changeRole: (id: string, userId: string, role: ShareableRole) =>
      api.patch<Member>(`/api/boards/${enc(id)}/members/${enc(userId)}`, { role }),
    removeMember: (id: string, userId: string) => api.delete(`/api/boards/${enc(id)}/members/${enc(userId)}`),

    invites: (id: string) => api.get<Invite[]>(`/api/boards/${enc(id)}/invites`),
    createInvite: (id: string, role: ShareableRole, expiresInHours: number | null) =>
      api.post<Invite>(`/api/boards/${enc(id)}/invite`, { role, expires_in_hours: expiresInHours }),
    revokeInvite: (id: string, inviteId: string) => api.delete(`/api/boards/${enc(id)}/invites/${enc(inviteId)}`),

    previewInvite: (token: string) => api.get<InvitePreview>(`/api/invites/${enc(token)}`),
    acceptInvite: (token: string) => api.post<JoinResult>(`/api/invites/${enc(token)}/accept`),
  };
}

/** Pizarra (Python): estado guardado del lienzo. El dibujo en vivo va por WebSocket. */
export function canvasApi(api: ApiClient) {
  return {
    state: (boardId: string) => api.get<CanvasState>(`/api/canvas/boards/${enc(boardId)}/state`),
  };
}

/** Chat (Java): historial paginado y envío idempotente. */
export function chatApi(api: ApiClient) {
  return {
    page: (boardId: string, opts: { before?: string | null; limit?: number } = {}, signal?: AbortSignal) =>
      api.get<ChatPage>(
        `/api/chat/boards/${enc(boardId)}/messages${query({ before: opts.before, limit: opts.limit ?? CHAT_PAGE_SIZE })}`,
        signal,
      ),
    /** Mensajes posteriores a `afterId` (recuperación tras reconectar o en modo sondeo). */
    since: (boardId: string, afterId: string, signal?: AbortSignal) =>
      api.get<ChatPage>(`/api/chat/boards/${enc(boardId)}/messages${query({ after: afterId, limit: 100 })}`, signal),
    send: (boardId: string, message: SendChatMessage) =>
      api.post<ChatMessage>(`/api/chat/boards/${enc(boardId)}/messages`, message),
  };
}

/** Notificaciones (C#): bandeja del usuario autenticado. */
export function notificationsApi(api: ApiClient) {
  return {
    list: (opts: { limit?: number } = {}, signal?: AbortSignal) =>
      api.get<NotificationList>(`/api/notifications${query({ limit: opts.limit ?? 20 })}`, signal),
    markRead: (id: string) => api.patch<AppNotification>(`/api/notifications/${enc(id)}/read`),
  };
}

export interface Apis {
  boards: ReturnType<typeof boardsApi>;
  canvas: ReturnType<typeof canvasApi>;
  chat: ReturnType<typeof chatApi>;
  notifications: ReturnType<typeof notificationsApi>;
}

export function createApis(api: ApiClient): Apis {
  return {
    boards: boardsApi(api),
    canvas: canvasApi(api),
    chat: chatApi(api),
    notifications: notificationsApi(api),
  };
}
