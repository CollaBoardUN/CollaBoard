"use client";

/**
 * Campana con la bandeja de notificaciones (invitación aceptada, mensaje de chat).
 * Se refresca sola cada pocos segundos; abrir una notificación la marca como leída.
 */
import { Bell } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { useStore } from "zustand";

import { describeNotification, type AppNotification, type NotificationList } from "@/core/domain/notifications";
import { relativeTime } from "@/core/lib/format";
import { createInboxStore, InboxController } from "@/core/notifications/inbox";
import { toast } from "@/core/stores/toastStore";
import { useApis } from "../AppContext";
import { useNavigation } from "../navigation";

export function NotificationBell({ initial }: { initial?: NotificationList | null }) {
  const apis = useApis();
  const { push } = useNavigation();
  const [store] = useState(() => createInboxStore(initial));
  const [controller] = useState(() => new InboxController({ apis, store }));
  const items = useStore(store, (s) => s.items);
  const unread = useStore(store, (s) => s.unread);
  const status = useStore(store, (s) => s.status);
  const error = useStore(store, (s) => s.error);
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    controller.start();
    return () => controller.stop();
  }, [controller]);

  useEffect(() => {
    if (!open) return;
    void controller.refresh();
    function onDoc(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, controller]);

  async function openNotification(notification: AppNotification) {
    try {
      await controller.markRead(notification.id);
    } catch (e) {
      toast.error((e as Error).message);
    }
    if (notification.board_id) {
      setOpen(false);
      push(`/boards/${encodeURIComponent(notification.board_id)}`);
    }
  }

  const label = unread > 0 ? `Notificaciones, ${unread} sin leer` : "Notificaciones";

  return (
    <div className="inbox" ref={rootRef}>
      <button
        type="button"
        className="icon-btn inbox-trigger"
        aria-label={label}
        title={label}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
      >
        <Bell size={19} aria-hidden="true" />
        {unread > 0 && (
          <span className="badge" data-testid="inbox-unread">
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>
      {open && (
        <section id={panelId} className="inbox-panel" aria-label="Bandeja de notificaciones">
          <header className="inbox-head">
            <h2>Notificaciones</h2>
            {unread > 0 && <span className="muted">{unread} sin leer</span>}
          </header>
          {status === "unavailable" && items.length === 0 ? (
            <p className="inbox-empty muted">{error}</p>
          ) : items.length === 0 ? (
            <p className="inbox-empty muted">
              {status === "idle" ? "Cargando…" : "No tienes notificaciones. Te avisaremos aquí."}
            </p>
          ) : (
            <ul className="inbox-list">
              {items.map((notification) => {
                const text = describeNotification(notification);
                const isUnread = !notification.read_at;
                return (
                  <li key={notification.id}>
                    <button
                      type="button"
                      className={isUnread ? "inbox-item inbox-unread" : "inbox-item"}
                      onClick={() => openNotification(notification)}
                    >
                      <span className="inbox-dot" aria-hidden="true" />
                      <span className="inbox-text">
                        <strong>{text.title}</strong>
                        <span className="muted">{text.body}</span>
                        <time dateTime={notification.created_at} suppressHydrationWarning>{relativeTime(notification.created_at)}</time>
                      </span>
                      {isUnread && <span className="sr-only">(sin leer)</span>}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {status === "unavailable" && items.length > 0 && <p className="inbox-foot muted">{error}</p>}
        </section>
      )}
    </div>
  );
}
