"use client";

import type { ReactNode } from "react";

import type { NotificationList } from "@/core/domain/notifications";
import { useClientConfig, useSessionUser } from "../AppContext";
import { NavLink } from "../navigation";
import { NotificationBell } from "../notifications/NotificationBell";
import { Avatar } from "./Avatar";
import { CollaBoardLogo } from "./CollaBoardLogo";

interface TopBarProps {
  onOpenNotifications?: () => void;
  /** Contenido central (p. ej. la cabecera del tablero). */
  children?: ReactNode;
  /** Bandeja renderizada en el servidor, para mostrar el contador sin esperar al cliente. */
  initialInbox?: NotificationList | null;
  /** Acción de cierre de sesión propia de cada presentación. */
  signOut?: ReactNode;
}

export function TopBar({ children, initialInbox, signOut, onOpenNotifications }: TopBarProps) {
  const user = useSessionUser();
  const { pixelsUrl } = useClientConfig();

  return (
    <header className="topbar">
      <NavLink href="/" className="brand-link" aria-label="CollaBoard, ir a mis tableros">
        <CollaBoardLogo size={32} />
        <span className="brand-text">
          <span className="brand-name">CollaBoard</span>
          <span className="brand-sub">Pizarra</span>
        </span>
      </NavLink>
      <div className="topbar-middle">{children}</div>
      <div className="topbar-end">
        {pixelsUrl && (
          <a href={pixelsUrl} className="btn btn-small nav-pixels-btn" title="Ir al lienzo colaborativo de Pixels">
            <span aria-hidden="true">🎨</span>
            <span>Pixels ↗</span>
          </a>
        )}
        <NotificationBell initial={initialInbox} onOpen={onOpenNotifications} />
        <div className="topbar-user">
          <Avatar id={user.id} name={user.name} size={30} />
          <span className="topbar-name">{user.name}</span>
          {signOut}
        </div>
      </div>
    </header>
  );
}
