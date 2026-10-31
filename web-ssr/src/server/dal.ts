import "server-only";

/**
 * Capa de acceso a datos (DAL) del servidor web.
 *
 * Todo lo que el SSR necesita pasa por aquí: lee la sesión una vez por petición
 * (`cache` de React), la verifica con Auth y consulta las APIs por el gateway con
 * la identidad del usuario. Ninguna función recibe un `userId` desde fuera: así
 * no se pueden pedir datos de otra cuenta.
 */
import { redirect } from "next/navigation";
import { cache } from "react";

import type { CanvasState } from "@/core/domain/canvasState";
import type { ChatPage } from "@/core/domain/chat";
import { CHAT_PAGE_SIZE } from "@/core/domain/chat";
import type { NotificationList } from "@/core/domain/notifications";
import type { Board, InvitePreview, SessionUser } from "@/core/domain/types";
import { GatewayError, gatewayJson } from "./gateway";
import { log } from "./log";
import { currentRequestId } from "./requestId";
import { readSessionToken } from "./session";

interface Session {
  user: SessionUser;
  token: string;
}

interface AuthMe {
  id: string;
  name: string;
  email: string;
}

const enc = encodeURIComponent;

/** Sesión verificada por Auth (`GET /api/auth/me`), o `null`. Una sola vez por petición. */
export const getSession = cache(async (): Promise<Session | null> => {
  const token = await readSessionToken();
  if (!token) return null;
  try {
    const me = await gatewayJson<AuthMe>("/api/auth/me", { token, requestId: await currentRequestId() });
    return { token, user: { id: me.id, name: me.name || me.email, email: me.email } };
  } catch (error) {
    if (error instanceof GatewayError && error.status === 401) return null;
    throw error;
  }
});

/** Usuario actual o redirección al login conservando a dónde quería ir. */
export async function requireSession(nextPath: string): Promise<Session> {
  const session = await getSession();
  if (!session) redirect(`/session/expired?next=${enc(nextPath)}`);
  return session;
}

async function authed<T>(path: string, nextPath: string): Promise<T> {
  const { token } = await requireSession(nextPath);
  try {
    return await gatewayJson<T>(path, { token, requestId: await currentRequestId() });
  } catch (error) {
    // El token pudo vencer entre la verificación y esta llamada.
    if (error instanceof GatewayError && error.status === 401) redirect(`/session/expired?next=${enc(nextPath)}`);
    throw error;
  }
}

/** Una consulta opcional no debe tumbar la página: si falla, la interfaz la pide después. */
async function optional<T>(load: () => Promise<T>, what: string): Promise<T | null> {
  try {
    return await load();
  } catch (error) {
    // `redirect()` lanza un error especial que debe propagarse.
    if (!(error instanceof GatewayError)) throw error;
    log("warn", "ssr_optional_unavailable", { what, status: error.status, request_id: await currentRequestId() });
    return null;
  }
}

export const listMyBoards = cache(async (): Promise<Board[]> => authed<Board[]>("/api/boards", "/"));

export type BoardLookup = { kind: "ok"; board: Board } | { kind: "not_found" } | { kind: "forbidden" };

export const getBoard = cache(async (boardId: string): Promise<BoardLookup> => {
  const nextPath = `/boards/${enc(boardId)}`;
  try {
    return { kind: "ok", board: await authed<Board>(`/api/boards/${enc(boardId)}`, nextPath) };
  } catch (error) {
    if (error instanceof GatewayError && error.status === 404) return { kind: "not_found" };
    if (error instanceof GatewayError && error.status === 403) return { kind: "forbidden" };
    throw error;
  }
});

export async function getCanvasState(boardId: string): Promise<CanvasState | null> {
  return optional(
    () => authed<CanvasState>(`/api/canvas/boards/${enc(boardId)}/state`, `/boards/${enc(boardId)}`),
    "canvas_state",
  );
}

export async function getChatFirstPage(boardId: string): Promise<ChatPage | null> {
  return optional(
    () =>
      authed<ChatPage>(`/api/chat/boards/${enc(boardId)}/messages?limit=${CHAT_PAGE_SIZE}`, `/boards/${enc(boardId)}`),
    "chat_page",
  );
}

export async function getInbox(nextPath: string): Promise<NotificationList | null> {
  return optional(() => authed<NotificationList>("/api/notifications?limit=20", nextPath), "inbox");
}

export type InviteLookup = { kind: "ok"; preview: InvitePreview } | { kind: "invalid"; message: string };

export async function previewInvite(token: string): Promise<InviteLookup> {
  try {
    return { kind: "ok", preview: await authed<InvitePreview>(`/api/invites/${enc(token)}`, `/join/${enc(token)}`) };
  } catch (error) {
    if (error instanceof GatewayError && error.status >= 400 && error.status < 500) {
      return { kind: "invalid", message: error.message };
    }
    throw error;
  }
}
