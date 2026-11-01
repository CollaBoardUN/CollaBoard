"use client";

import { Bell, CheckCheck, ExternalLink, RefreshCw, Trash2, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useStore } from "zustand";

import { describeNotification, type NotificationList } from "@/core/domain/notifications";
import { relativeTime } from "@/core/lib/format";
import { createInboxStore, InboxController } from "@/core/notifications/inbox";
import { toast } from "@/core/stores/toastStore";
import { useApis } from "../AppContext";
import { useNavigation } from "../navigation";

export function NotificationBell({ initial, onOpen }: { initial?: NotificationList | null; onOpen?: () => void }) {
  const apis = useApis();
  const { push } = useNavigation();
  const [store] = useState(() => createInboxStore(initial));
  const [controller] = useState(() => new InboxController({ apis, store }));
  const { items, unread, status, error } = useStore(store);
  const [open, setOpen] = useState(false);
  const [onlyUnread, setOnlyUnread] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const panelId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => { controller.start(); return () => controller.stop(); }, [controller]);
  useEffect(() => {
    if (!open) return;
    void controller.refresh();
    function onDoc(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node) && !panelRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") { setOpen(false); triggerRef.current?.focus(); }
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
  }, [open, controller]);

  async function act(action: () => Promise<void>) {
    setBusy(true);
    try { await action(); setConfirmDelete(false); }
    catch (e) { toast.error((e as Error).message || "No se pudo actualizar la bandeja"); }
    finally { setBusy(false); }
  }
  const label = unread > 0 ? `Notificaciones, ${unread} sin leer` : "Notificaciones";
  const visible = onlyUnread ? items.filter((n) => !n.read_at) : items;

  return <div className="inbox" ref={rootRef}>
    <button ref={triggerRef} type="button" className="icon-btn inbox-trigger" aria-label={label} title={label}
      aria-expanded={open} aria-controls={panelId} onClick={() => {
        if (!open) { onOpen?.(); setConfirmDelete(false); }
        setOpen((v) => !v);
      }}>
      <Bell size={19} aria-hidden="true" />
      {unread > 0 && <span className="badge" data-testid="inbox-unread">{unread > 99 ? "99+" : unread}</span>}
    </button>
    {open && createPortal(<section ref={panelRef} id={panelId} className="inbox-panel" aria-label="Bandeja de notificaciones" aria-busy={busy}>
      <header className="inbox-head">
        <div><h2>Notificaciones</h2><span className="muted">{unread ? `${unread} sin leer` : "Estás al día"}</span></div>
        <div className="inbox-header-actions">
          <button className="icon-btn" type="button" aria-label="Actualizar notificaciones" disabled={busy} onClick={() => void act(() => controller.refresh())}><RefreshCw size={16} /></button>
          <button className="icon-btn" type="button" aria-label="Cerrar notificaciones" onClick={() => { setOpen(false); triggerRef.current?.focus(); }}><X size={18} /></button>
        </div>
      </header>
      <div className="inbox-toolbar">
        <div className="inbox-filters" role="group" aria-label="Filtrar notificaciones">
          <button type="button" aria-pressed={!onlyUnread} onClick={() => setOnlyUnread(false)}>Todas</button>
          <button type="button" aria-pressed={onlyUnread} onClick={() => setOnlyUnread(true)}>Sin leer</button>
        </div>
        <button type="button" className="inbox-action" disabled={busy || unread === 0} onClick={() => void act(controller.markAllRead)}><CheckCheck size={15} />Leer todas</button>
        <button type="button" className="inbox-action inbox-danger" disabled={busy || items.length === 0} onClick={() => setConfirmDelete(true)}><Trash2 size={15} />Borrar todas</button>
      </div>
      {confirmDelete && <div className="inbox-confirm" role="group" aria-label="Confirmar borrado">
        <p>¿Borrar todas tus notificaciones?</p>
        <button type="button" disabled={busy} onClick={() => setConfirmDelete(false)}>Cancelar</button>
        <button type="button" className="inbox-danger" disabled={busy} onClick={() => void act(controller.removeAll)}>Confirmar borrado</button>
      </div>}
      {status === "unavailable" && <p className="inbox-foot muted" role="status">{error}</p>}
      {visible.length === 0 ? <div className="inbox-empty"><Bell size={28} aria-hidden="true" /><strong>{onlyUnread ? "No tienes notificaciones sin leer" : status === "idle" ? "Cargando…" : "No tienes notificaciones"}</strong><span className="muted">Aquí aparecerá la actividad de tus tableros.</span></div> :
        <ul className="inbox-list">{visible.map((notification) => {
          const text = describeNotification(notification);
          const isUnread = !notification.read_at;
          return <li key={notification.id} className={isUnread ? "inbox-row inbox-unread" : "inbox-row"}>
            <button type="button" className="inbox-item" disabled={busy} onClick={() => void act(() => controller.markRead(notification.id))} title={isUnread ? "Marcar como leída" : "Notificación leída"}>
              <span className="inbox-dot" aria-hidden="true" />
              <span className="inbox-text"><strong>{text.title}</strong><span className="inbox-preview">{text.body}</span><time dateTime={notification.created_at} suppressHydrationWarning>{relativeTime(notification.created_at)}</time></span>
              {isUnread && <span className="sr-only">(sin leer)</span>}
            </button>
            <div className="inbox-row-actions">
              {notification.board_id && <button type="button" className="icon-btn" aria-label={`Abrir tablero de ${text.title}`} title="Abrir tablero" onClick={() => { setOpen(false); push(`/boards/${encodeURIComponent(notification.board_id!)}`); }}><ExternalLink size={15} /></button>}
              <button type="button" className="icon-btn inbox-danger" disabled={busy} aria-label={`Borrar notificación: ${text.title}`} title="Borrar notificación" onClick={() => void act(() => controller.remove(notification.id))}><Trash2 size={15} /></button>
            </div>
          </li>;
        })}</ul>}
      <footer className="inbox-foot muted">Se actualiza automáticamente · Pulsa una notificación para marcarla como leída.</footer>
    </section>, document.body)}
  </div>;
}
