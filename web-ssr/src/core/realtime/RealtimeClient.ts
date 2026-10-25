/**
 * Cliente WebSocket de un tablero: conexión, reconexión con espera creciente,
 * orden de eventos y cola de operaciones pendientes. No conoce React ni el store.
 *
 * Garantías:
 * - ORDEN: los lotes del servidor traen `seq`. Si llega uno repetido se ignora;
 *   si falta alguno (hueco) se pide un `sync` completo y se descarta lo demás
 *   hasta recibirlo.
 * - RECONEXIÓN: tras una caída reintenta con espera exponencial. Al volver, el
 *   servidor manda el estado completo y aquí se reenvían los lotes que no
 *   fueron confirmados (`ack`), así no se pierde lo dibujado sin conexión.
 * - TRANSPORTE: no crea el WebSocket; lo pide a `connect()`, que lo abre con el
 *   transporte de cada presentación (web: cookie; Electron: IPC). Por eso aquí ya
 *   no hay token en la URL.
 */
import {
  CLOSE_FORBIDDEN,
  CLOSE_UNAUTHORIZED,
  type ClientMessage,
  type ElementOp,
  type OpsMessage,
  type Peer,
  type ServerMessage,
  type SyncMessage,
} from "./protocol";
import type { CanvasElement } from "@/core/domain/canvas";
import { SOCKET_CONNECTING, SOCKET_OPEN, type SocketLike } from "@/core/transport/types";

export type RealtimeStatus = "connecting" | "online" | "reconnecting" | "denied" | "closed";

export interface RealtimeHandlers {
  onStatus: (status: RealtimeStatus) => void;
  onSync: (message: SyncMessage) => void;
  onOps: (message: OpsMessage) => void;
  onPresence: (peers: Peer[]) => void;
  onCursor: (conn: string, x: number, y: number) => void;
  onDraft: (conn: string, element: CanvasElement | null) => void;
  /** El servidor rechazó un dibujo (rol de solo lectura). */
  onForbidden: () => void;
  /** El autosave persistió el tablero hasta `seq` (distinto de `ack`, que solo confirma proceso). */
  onSaved?: (seq: number, savedAt: string) => void;
  onSaveError?: (message: string) => void;
  /** Alguien restauró una versión; justo después llega un `sync` completo. */
  onRestored?: (by: string | null) => void;
}

export interface RealtimeClientOptions {
  /** Abre un socket nuevo en cada intento. `null` = no hay sesión: no se reintenta. */
  connect: () => SocketLike | null;
  handlers: RealtimeHandlers;
}

interface Batch {
  ref: number;
  ops: ElementOp[];
  /** Ya se envió por el socket actual (si se cae, vuelve a false al reconectar). */
  sent: boolean;
}

const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 10_000;
const PING_EVERY_MS = 20_000;
const SILENCE_LIMIT_MS = 50_000;
const MAX_OUTBOX = 2_000;

export class RealtimeClient {
  private ws: SocketLike | null = null;
  private attempts = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private lastHeard = 0;
  private lastSeq = 0;
  private ready = false;
  private resendOnSync = false;
  private stopped = true;
  private refCounter = 0;
  private outbox: Batch[] = [];

  constructor(private readonly options: RealtimeClientOptions) {}

  connect(): void {
    this.stopped = false;
    globalThis.addEventListener?.("online", this.onBrowserOnline);
    this.open();
  }

  close(): void {
    this.stopped = true;
    globalThis.removeEventListener?.("online", this.onBrowserOnline);
    clearTimeout(this.retryTimer);
    this.teardown(this.ws);
    this.options.handlers.onStatus("closed");
  }

  /** Envía crear/mover/borrar. Si no hay conexión, queda en cola hasta reconectar. */
  sendOps(ops: ElementOp[]): void {
    if (ops.length === 0) return;
    const batch: Batch = { ref: ++this.refCounter, ops, sent: false };
    this.outbox.push(batch);
    if (this.outbox.length > MAX_OUTBOX) this.outbox.shift();
    if (this.ready) this.flush();
  }

  sendCursor(x: number, y: number): void {
    if (this.ready) this.send({ type: "cursor", x, y });
  }

  sendDraft(element: CanvasElement | null): void {
    if (this.ready) this.send({ type: "draft", element });
  }

  /** Pide el estado completo (p. ej. tras un hueco en la secuencia). */
  resync(): void {
    this.ready = false;
    this.send({ type: "resync" });
  }

  // ------------------------------------------------------------ conexión

  private open(): void {
    this.options.handlers.onStatus(this.attempts === 0 ? "connecting" : "reconnecting");

    let ws: SocketLike | null;
    try {
      ws = this.options.connect();
    } catch {
      this.scheduleReconnect();
      return;
    }
    if (!ws) {
      this.options.handlers.onStatus("denied");
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.lastHeard = Date.now();
      this.resendOnSync = true;
      this.heartbeat = setInterval(() => this.beat(ws), PING_EVERY_MS);
    };
    ws.onmessage = (event) => {
      this.lastHeard = Date.now();
      this.handle(event.data);
    };
    ws.onerror = () => {
      // El cierre llega justo después y se gestiona en onclose.
    };
    ws.onclose = (event) => this.onClosed(ws, event.code);
  }

  private onClosed(ws: SocketLike, code: number): void {
    if (this.ws !== ws) return;
    this.teardown(ws);
    if (this.stopped) return;
    if (code === CLOSE_UNAUTHORIZED || code === CLOSE_FORBIDDEN) {
      this.options.handlers.onStatus("denied");
      return;
    }
    this.scheduleReconnect();
  }

  private teardown(ws: SocketLike | null): void {
    clearInterval(this.heartbeat);
    this.ready = false;
    if (!ws) return;
    ws.onopen = null;
    ws.onmessage = null;
    ws.onerror = null;
    ws.onclose = null;
    if (ws.readyState === SOCKET_OPEN || ws.readyState === SOCKET_CONNECTING) ws.close();
    if (this.ws === ws) this.ws = null;
  }

  private scheduleReconnect(): void {
    this.options.handlers.onStatus("reconnecting");
    const delay = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** this.attempts);
    this.attempts += 1;
    clearTimeout(this.retryTimer);
    // Jitter para que muchos clientes no reconecten todos a la vez.
    this.retryTimer = setTimeout(() => this.open(), delay * (0.5 + Math.random() * 0.5));
  }

  private readonly onBrowserOnline = (): void => {
    if (this.stopped || this.ws) return;
    clearTimeout(this.retryTimer);
    this.open();
  };

  /** Latido: mantiene vivo el proxy y detecta conexiones muertas sin evento de cierre. */
  private beat(ws: SocketLike): void {
    if (Date.now() - this.lastHeard > SILENCE_LIMIT_MS) {
      this.onClosed(ws, 4000);
      return;
    }
    this.send({ type: "ping" });
  }

  private send(message: ClientMessage): void {
    if (this.ws?.readyState === SOCKET_OPEN) this.ws.send(JSON.stringify(message));
  }

  /** Envía, en orden, los lotes que aún no se han mandado. */
  private flush(): void {
    for (const batch of this.outbox) {
      if (batch.sent) continue;
      batch.sent = true;
      this.send({ type: "ops", ref: batch.ref, ops: batch.ops });
    }
  }

  // ------------------------------------------------------------ mensajes

  private handle(raw: unknown): void {
    let message: ServerMessage;
    try {
      message = JSON.parse(String(raw)) as ServerMessage;
    } catch {
      return;
    }
    const { handlers } = this.options;

    switch (message.type) {
      case "sync":
        this.lastSeq = message.seq;
        this.ready = true;
        this.attempts = 0;
        handlers.onStatus("online");
        handlers.onSync(message);
        if (this.resendOnSync) {
          this.resendOnSync = false;
          for (const batch of this.outbox) batch.sent = false; // socket nuevo: reenviar todo lo no confirmado
        }
        this.flush();
        break;
      case "ops":
        if (!this.ready || message.seq <= this.lastSeq) break; // esperando sync, o repetido
        if (message.seq > this.lastSeq + 1) {
          this.resync(); // se perdió un lote: pedimos el estado completo
          break;
        }
        this.lastSeq = message.seq;
        handlers.onOps(message);
        break;
      case "ack":
        this.outbox = this.outbox.filter((batch) => batch.ref !== message.ref);
        break;
      case "presence":
        handlers.onPresence(message.peers);
        break;
      case "cursor":
        handlers.onCursor(message.conn, message.x, message.y);
        break;
      case "draft":
        handlers.onDraft(message.conn, message.element);
        break;
      case "error":
        if (message.code === "forbidden") {
          this.outbox = [];
          handlers.onForbidden();
          this.resync(); // descarta lo dibujado localmente que el servidor no aceptó
        }
        break;
      case "saved":
        handlers.onSaved?.(message.seq, message.saved_at);
        break;
      case "save_error":
        handlers.onSaveError?.(message.message);
        break;
      case "restored":
        handlers.onRestored?.(message.by ?? null);
        break;
      case "pong":
        break;
    }
  }
}
