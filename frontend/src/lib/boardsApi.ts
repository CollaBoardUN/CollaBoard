/** Funciones tipadas para cada endpoint de la Persona 1. */
import { api } from "./api";
import type {
  Board,
  Invite,
  InvitePreview,
  JoinResult,
  Member,
  ShareableRole,
} from "./types";

const enc = encodeURIComponent;

export const boardsApi = {
  list: () => api.get<Board[]>("/boards"),
  get: (id: string) => api.get<Board>(`/boards/${enc(id)}`),
  create: (name: string) => api.post<Board>("/boards", { name }),
  rename: (id: string, name: string) => api.patch<Board>(`/boards/${enc(id)}`, { name }),
  remove: (id: string) => api.delete(`/boards/${enc(id)}`),

  members: (id: string) => api.get<Member[]>(`/boards/${enc(id)}/members`),
  changeRole: (id: string, userId: string, role: ShareableRole) =>
    api.patch<Member>(`/boards/${enc(id)}/members/${enc(userId)}`, { role }),
  removeMember: (id: string, userId: string) =>
    api.delete(`/boards/${enc(id)}/members/${enc(userId)}`),

  invites: (id: string) => api.get<Invite[]>(`/boards/${enc(id)}/invites`),
  createInvite: (id: string, role: ShareableRole, expiresInHours: number | null) =>
    api.post<Invite>(`/boards/${enc(id)}/invite`, { role, expires_in_hours: expiresInHours }),
  revokeInvite: (id: string, inviteId: string) =>
    api.delete(`/boards/${enc(id)}/invites/${enc(inviteId)}`),

  previewInvite: (token: string) => api.get<InvitePreview>(`/invites/${enc(token)}`),
  acceptInvite: (token: string) => api.post<JoinResult>(`/invites/${enc(token)}/accept`),
};

export const devAuthApi = {
  token: (userId: string, name: string) =>
    api.post<{ access_token: string }>("/dev/token", { user_id: userId, name }),
};
