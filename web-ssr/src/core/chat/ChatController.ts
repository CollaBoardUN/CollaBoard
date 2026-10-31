/**
 * Orquesta el chat de un tablero sin conocer React:
 *
 * - Historial: primera página (si no vino renderizada del servidor) y páginas
 *   anteriores por cursor.
 * - Envío: solo por HTTP. Cada mensaje lleva un `client_message_id` estable; un
 *   reintento reutiliza el mismo id y el servidor no lo duplica.
 * - En vivo: WebSocket `/ws/chat/boards/{id}`. Al (re)conectar se recupera lo que
 *   llegó mientras tanto con `?after=`. Si el socket cae, se sondea por HTTP
 *   hasta reconectar. 4401/4403 detienen todo (sin sesión o sin acceso).
 */
import type { Apis } from "../api";
import { validateChatText, type ChatMessage, type ChatServerMessage } from "../domain/chat";
import { newId } from "../lib/id";
import { ApiError } from "../transport/apiClient";
import { SOCKET_OPEN, type SocketLike, type Transport } from "../transport/types";
import type { ChatStore } from "./chatStore";

export const CHAT_CLOSE_UNAUTHORIZED = 4401;
export const CHAT_CLOSE_FORBIDDEN = 4403;

export interface ChatControllerOptions {
  boardId: string;
  apis: Pick<Apis, "chat">;
  transport: Pick<Transport, "openSocket">;
  store: ChatStore;
  pollEveryMs?: number;
  pingEveryMs?: number;
  maxReconnectDelayMs?: number;
}

export class ChatController {
  private socket: SocketLike | null = null;
  private stopped = true;
  private attempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private catchingUp = false;

  constructor(private readonly options: ChatControllerOptions) {}

  private get store() {
    return this.options.store.getState();
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    if (this.store.history === "idle" || this.store.history === "error") void this.loadFirstPage();
    this.openSocket();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    this.stopPolling();
    this.closeSocket();
    this.store.setLive("closed");
  }

  async loadFirstPage(): Promise<void> {
    this.store.setHistoryLoading();
    try {
      this.store.setPage(await this.options.apis.chat.page(this.options.boardId));
    } catch (error) {
      this.store.setHistoryError((error as Error).message);
    }
  }

  async loadOlder(): Promise<void> {
    const { nextCursor, loadingOlder } = this.store;
    if (!nextCursor || loadingOlder) return;
    this.store.setLoadingOlder(true);
    try {
      this.store.prependOlder(await this.options.apis.chat.page(this.options.boardId, { before: nextCursor }));
    } catch {
      this.store.setLoadingOlder(false);
      throw new Error("No se pudieron cargar los mensajes anteriores");
    }
  }

  /** Devuelve el error de validación (si lo hay) sin enviar nada. */
  send(text: string): string | null {
    const invalid = validateChatText(text);
    if (invalid) return invalid;
    const pending = {
      client_message_id: newId(),
      text: text.trim(),
      created_at: new Date().toISOString(),
      status: "sending" as const,
    };
    this.store.addPending(pending);
    void this.deliver(pending.client_message_id, pending.text);
    return null;
  }

  retry(clientMessageId: string): void {
    const pending = this.store.retryPending(clientMessageId);
    if (pending) void this.deliver(pending.client_message_id, pending.text);
  }

  private async deliver(clientMessageId: string, text: string): Promise<void> {
    try {
      const saved = await this.options.apis.chat.send(this.options.boardId, {
        text,
        client_message_id: clientMessageId,
      });
      this.store.receive([saved]);
    } catch (error) {
      const message =
        error instanceof ApiError && error.status === 0 ? "Sin conexión. Toca para reintentar" : (error as Error).message;
      this.store.failPending(clientMessageId, message);
    }
  }

  // ------------------------------------------------------------ en vivo

  private openSocket(): void {
    if (this.stopped) return;
    // Mientras se reintenta, el sondeo sigue activo: la interfaz no debe parecer caída.
    if (this.store.live !== "polling") this.store.setLive("connecting");
    let socket: SocketLike;
    try {
      socket = this.options.transport.openSocket(`/ws/chat/boards/${encodeURIComponent(this.options.boardId)}`);
    } catch {
      this.onSocketLost();
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      this.attempts = 0;
      this.stopPolling();
      this.store.setLive("online");
      this.pingTimer = setInterval(() => this.ping(), this.options.pingEveryMs ?? 25_000);
      void this.catchUp();
    };
    socket.onmessage = (event) => this.handle(event.data);
    socket.onerror = () => {
      // El cierre llega después y se gestiona en onclose.
    };
    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      this.closeSocket();
      if (this.stopped) return;
      if (event.code === CHAT_CLOSE_UNAUTHORIZED || event.code === CHAT_CLOSE_FORBIDDEN) {
        this.stopPolling();
        this.store.setLive("denied");
        return;
      }
      this.onSocketLost();
    };
  }

  private onSocketLost(): void {
    if (this.stopped) return;
    this.store.setLive("polling");
    this.startPolling();
    const max = this.options.maxReconnectDelayMs ?? 15_000;
    const delay = Math.min(max, 1_000 * 2 ** this.attempts);
    this.attempts += 1;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.openSocket(), delay * (0.5 + Math.random() * 0.5));
  }

  private closeSocket(): void {
    clearInterval(this.pingTimer);
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    if (socket.readyState <= SOCKET_OPEN) socket.close();
  }

  private ping(): void {
    if (this.socket?.readyState === SOCKET_OPEN) this.socket.send(JSON.stringify({ type: "ping" }));
  }

  private handle(raw: unknown): void {
    let message: ChatServerMessage;
    try {
      message = JSON.parse(String(raw)) as ChatServerMessage;
    } catch {
      return;
    }
    if (message.type === "message" && message.message?.board_id === this.options.boardId) {
      this.store.receive([message.message]);
    }
  }

  private startPolling(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => void this.catchUp(), this.options.pollEveryMs ?? 4_000);
  }

  private stopPolling(): void {
    clearInterval(this.pollTimer);
    this.pollTimer = undefined;
  }

  /** Trae lo posterior al último mensaje conocido (o la primera página si no hay ninguno). */
  private async catchUp(): Promise<void> {
    if (this.catchingUp || this.stopped) return;
    this.catchingUp = true;
    try {
      const last: ChatMessage | undefined = this.store.messages.at(-1);
      const page = last
        ? await this.options.apis.chat.since(this.options.boardId, last.id)
        : await this.options.apis.chat.page(this.options.boardId);
      if (last) this.store.receive(page.items);
      else this.store.setPage(page);
    } catch (error) {
      if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
        this.stopPolling();
        this.store.setLive("denied");
      }
    } finally {
      this.catchingUp = false;
    }
  }
}
