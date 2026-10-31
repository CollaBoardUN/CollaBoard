"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { relativeTime } from "@/core/lib/format";
import { doodleFor } from "@/core/lib/ink";
import type { Board } from "@/core/domain/types";
import { RoleBadge } from "../common/RoleBadge";
import { NavLink } from "../navigation";

export type BoardAction = "rename" | "share" | "delete" | "leave";

interface Props {
  board: Board;
  onAction: (action: BoardAction, board: Board) => void;
  /** Miniatura real; la genera el módulo de persistencia (Persona 4). */
  thumbnailUrl?: string;
}

/** Garabato propio de cada tablero, mientras no exista miniatura real. */
function Doodle({ seed }: { seed: string }) {
  const g = useMemo(() => doodleFor(seed), [seed]);
  return (
    <svg className="doodle" viewBox="0 0 240 120" aria-hidden="true" preserveAspectRatio="none">
      <path d={g.path} fill="none" stroke={g.color} strokeWidth="3" strokeLinecap="round" opacity="0.55" />
      <ellipse cx={g.cx} cy={g.cy} rx={g.rx} ry={g.ry} fill="none" stroke="#23272e" strokeWidth="2.5" opacity="0.28" />
    </svg>
  );
}

export function BoardCard({ board, onAction, thumbnailUrl }: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const isOwner = board.my_role === "owner";

  useEffect(() => {
    if (!menuOpen) return;
    function onDoc(e: MouseEvent) {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setMenuOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  function act(action: BoardAction) {
    setMenuOpen(false);
    onAction(action, board);
  }

  return (
    <article className="board-card">
      <NavLink href={`/boards/${board.id}`} className="board-surface" aria-label={`Abrir ${board.name}`}>
        {thumbnailUrl ? <img src={thumbnailUrl} alt="" /> : <Doodle seed={board.id} />}
        <span className="board-title">{board.name}</span>
      </NavLink>
      <footer className="board-meta">
        <div className="board-meta-text">
          <RoleBadge role={board.my_role} />
          <span className="muted" suppressHydrationWarning>
            {board.member_count === 1 ? "Solo tú" : `${board.member_count} personas`}, editado{" "}
            {relativeTime(board.updated_at)}
          </span>
        </div>
        <div className="menu" ref={menuRef}>
          <button
            type="button"
            className="icon-btn"
            aria-label={`Opciones de ${board.name}`}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((v) => !v)}
          >
            <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
              <circle cx="4" cy="10" r="1.8" fill="currentColor" />
              <circle cx="10" cy="10" r="1.8" fill="currentColor" />
              <circle cx="16" cy="10" r="1.8" fill="currentColor" />
            </svg>
          </button>
          {menuOpen && (
            <div className="menu-list" role="menu">
              {isOwner && (
                <button type="button" role="menuitem" onClick={() => act("rename")}>
                  Renombrar
                </button>
              )}
              <button type="button" role="menuitem" onClick={() => act("share")}>
                {isOwner ? "Compartir" : "Ver miembros"}
              </button>
              {isOwner ? (
                <button type="button" role="menuitem" className="danger" onClick={() => act("delete")}>
                  Borrar tablero
                </button>
              ) : (
                <button type="button" role="menuitem" className="danger" onClick={() => act("leave")}>
                  Salir del tablero
                </button>
              )}
            </div>
          )}
        </div>
      </footer>
    </article>
  );
}
