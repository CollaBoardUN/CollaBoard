"use client";

/**
 * Panel de chat del tablero: historial paginado, envío idempotente y recepción
 * en vivo. Permanece montado aunque esté cerrado para contar los no leídos.
 */
import { MessageSquare, RotateCcw, Send, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { useStore } from "zustand";

import { ChatController } from "@/core/chat/ChatController";
import { createChatStore, type LiveStatus, type PendingMessage } from "@/core/chat/chatStore";
import { CHAT_MAX_LENGTH, type ChatMessage, type ChatPage } from "@/core/domain/chat";
import { APP_TIME_ZONE, initials } from "@/core/lib/format";
import { inkFor } from "@/core/lib/ink";
import { toast } from "@/core/stores/toastStore";
import { useApis, useSessionUser, useTransport } from "../AppContext";

const LIVE_LABEL: Record<LiveStatus, string> = {
  connecting: "Conectando…",
  online: "En vivo",
  polling: "Reconectando · actualizando cada pocos segundos",
  denied: "Sin acceso al chat",
  closed: "Desconectado",
};

// Zona horaria fija: el servidor (UTC en Docker) y el navegador deben producir el
// mismo texto para que la hidratación no falle.
const timeFormat = new Intl.DateTimeFormat("es-CO", { hour: "2-digit", minute: "2-digit", timeZone: APP_TIME_ZONE });
const dayFormat = new Intl.DateTimeFormat("es-CO", { day: "numeric", month: "short", timeZone: APP_TIME_ZONE });

function formatTime(iso: string, now = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const sameDay = dayFormat.format(date) === dayFormat.format(now);
  return sameDay ? timeFormat.format(date) : `${dayFormat.format(date)}, ${timeFormat.format(date)}`;
}

interface ChatPanelProps {
  boardId: string;
  open: boolean;
  onClose: () => void;
  /** Mensajes de otras personas recibidos con el panel cerrado. */
  onUnreadChange?: (count: number) => void;
  /** Primera página renderizada en el servidor (opcional). */
  initialPage?: ChatPage | null;
}

export function ChatPanel({ boardId, open, onClose, onUnreadChange, initialPage }: ChatPanelProps) {
  const apis = useApis();
  const transport = useTransport();
  const me = useSessionUser();
  const [store] = useState(() => createChatStore(initialPage));
  const [controller] = useState(() => new ChatController({ boardId, apis, transport, store }));
  const messages = useStore(store, (s) => s.messages);
  const pending = useStore(store, (s) => s.pending);
  const history = useStore(store, (s) => s.history);
  const historyError = useStore(store, (s) => s.historyError);
  const nextCursor = useStore(store, (s) => s.nextCursor);
  const loadingOlder = useStore(store, (s) => s.loadingOlder);
  const live = useStore(store, (s) => s.live);

  const [draft, setDraft] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const stickToBottom = useRef(true);
  // Instante hasta el que la persona ya "vio" el chat (montaje o última vez abierto).
  const [seenUntil, setSeenUntil] = useState(() => Date.now());

  useEffect(() => {
    controller.start();
    return () => controller.stop();
  }, [controller]);

  // Al cerrar el panel, todo lo que había quedó visto.
  useEffect(() => {
    if (!open) return;
    return () => setSeenUntil(Date.now());
  }, [open]);

  // No leídos: mensajes ajenos posteriores a la última vez que se vio el panel.
  useEffect(() => {
    const unseen = open
      ? 0
      : messages.filter((m) => m.sender_id !== me.id && Date.parse(m.created_at) > seenUntil).length;
    onUnreadChange?.(unseen);
  }, [messages, open, me.id, seenUntil, onUnreadChange]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // Mantiene la vista abajo si la persona ya estaba abajo (no la mueve si está leyendo arriba).
  useLayoutEffect(() => {
    const list = listRef.current;
    if (list && stickToBottom.current) list.scrollTop = list.scrollHeight;
  }, [messages.length, pending.length, open]);

  function onScroll() {
    const list = listRef.current;
    if (!list) return;
    stickToBottom.current = list.scrollHeight - list.scrollTop - list.clientHeight < 48;
  }

  async function loadOlder() {
    const list = listRef.current;
    const previousHeight = list?.scrollHeight ?? 0;
    stickToBottom.current = false;
    try {
      await controller.loadOlder();
      // Conserva la posición de lectura tras anteponer mensajes.
      requestAnimationFrame(() => {
        if (list) list.scrollTop += list.scrollHeight - previousHeight;
      });
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  function submit(event?: FormEvent) {
    event?.preventDefault();
    const error = controller.send(draft);
    setFormError(error);
    if (!error) {
      setDraft("");
      stickToBottom.current = true;
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  }

  const remaining = CHAT_MAX_LENGTH - draft.trim().length;

  return (
    <aside className={open ? "chat chat-open" : "chat"} aria-label="Chat del tablero" aria-hidden={!open} inert={!open}>
      <header className="chat-head">
        <MessageSquare size={18} aria-hidden="true" />
        <h2>Chat del tablero</h2>
        <span className={`chat-live chat-live-${live}`} role="status">
          <span className="presence-dot" aria-hidden="true" />
          {LIVE_LABEL[live]}
        </span>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Cerrar chat">
          <X size={18} aria-hidden="true" />
        </button>
      </header>

      <ol className="chat-list" ref={listRef} onScroll={onScroll} role="log" aria-live="polite" aria-relevant="additions">
        {nextCursor && (
          <li className="chat-older">
            <button type="button" className="btn btn-small btn-quiet" onClick={loadOlder} disabled={loadingOlder}>
              {loadingOlder ? "Cargando…" : "Ver mensajes anteriores"}
            </button>
          </li>
        )}
        {history === "loading" && messages.length === 0 && <li className="chat-note muted">Cargando mensajes…</li>}
        {history === "error" && (
          <li className="chat-note">
            <span className="form-error">No se pudo cargar el historial: {historyError}</span>
            <button type="button" className="btn btn-small btn-quiet" onClick={() => controller.loadFirstPage()}>
              Reintentar
            </button>
          </li>
        )}
        {history === "ready" && messages.length === 0 && pending.length === 0 && (
          <li className="chat-note muted">Aún no hay mensajes. ¡Saluda a tu equipo!</li>
        )}
        {messages.map((message, index) => (
          <MessageRow
            key={message.id}
            message={message}
            mine={message.sender_id === me.id}
            continued={index > 0 && messages[index - 1].sender_id === message.sender_id}
          />
        ))}
        {pending.map((p) => (
          <PendingRow key={p.client_message_id} pending={p} onRetry={() => controller.retry(p.client_message_id)} />
        ))}
      </ol>

      <form className="chat-compose" onSubmit={submit}>
        <label className="sr-only" htmlFor={`chat-input-${boardId}`}>
          Escribe un mensaje
        </label>
        <textarea
          id={`chat-input-${boardId}`}
          ref={inputRef}
          rows={2}
          value={draft}
          maxLength={CHAT_MAX_LENGTH + 200}
          placeholder={live === "denied" ? "No tienes acceso a este chat" : "Escribe un mensaje…"}
          disabled={live === "denied"}
          onChange={(e) => {
            setDraft(e.target.value);
            if (formError) setFormError(null);
          }}
          onKeyDown={onKeyDown}
          aria-invalid={formError ? true : undefined}
        />
        <div className="chat-compose-foot">
          <span className={remaining < 0 ? "form-error" : "muted"} aria-live="polite">
            {formError ?? (remaining < 200 ? `${remaining} caracteres restantes` : "Enter envía · Shift+Enter nueva línea")}
          </span>
          <button type="submit" className="btn btn-small btn-primary" disabled={live === "denied" || !draft.trim()}>
            <Send size={15} aria-hidden="true" /> Enviar
          </button>
        </div>
      </form>
    </aside>
  );
}

function MessageRow({ message, mine, continued }: { message: ChatMessage; mine: boolean; continued: boolean }) {
  const color = inkFor(message.sender_id);
  return (
    <li className={`chat-msg${mine ? " chat-mine" : ""}${continued ? " chat-continued" : ""}`}>
      {!mine && !continued && (
        <span className="avatar chat-avatar" style={{ borderColor: color, color }} aria-hidden="true">
          {initials(message.sender_name)}
        </span>
      )}
      <div className="chat-bubble">
        {!continued && (
          <div className="chat-meta">
            <strong>{mine ? "Tú" : message.sender_name}</strong>
            <time dateTime={message.created_at} suppressHydrationWarning>
              {formatTime(message.created_at)}
            </time>
          </div>
        )}
        <p>{message.text}</p>
      </div>
    </li>
  );
}

function PendingRow({ pending, onRetry }: { pending: PendingMessage; onRetry: () => void }) {
  const failed = pending.status === "failed";
  return (
    <li className={`chat-msg chat-mine chat-pending${failed ? " chat-failed" : ""}`}>
      <div className="chat-bubble">
        <p>{pending.text}</p>
        <div className="chat-meta">
          {failed ? (
            <button type="button" className="chat-retry" onClick={onRetry}>
              <RotateCcw size={13} aria-hidden="true" /> {pending.error ?? "No se envió"} · Reintentar
            </button>
          ) : (
            <span>Enviando…</span>
          )}
        </div>
      </div>
    </li>
  );
}
