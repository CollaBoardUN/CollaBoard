import type { ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";

import { useAuth } from "../auth/authStore";
import { useBoards } from "../stores/boardsStore";
import { Avatar } from "./Avatar";
import { CollaBoardLogo } from "./CollaBoardLogo";

export function TopBar({ children }: { children?: ReactNode }) {
  const user = useAuth((s) => s.user);
  const logout = useAuth((s) => s.logout);
  const resetBoards = useBoards((s) => s.reset);
  const navigate = useNavigate();

  function signOut() {
    logout();
    resetBoards();
    navigate("/login");
  }

  const pixelsUrl = import.meta.env.VITE_PIXELS_URL || "http://localhost:3000";

  return (
    <header className="topbar">
      <Link to="/" className="brand" style={{ display: "flex", alignItems: "center", gap: "0.6rem", textDecoration: "none" }}>
        <CollaBoardLogo size={32} />
        <div style={{ display: "flex", flexDirection: "column", lineHeight: 1.1 }}>
          <span style={{ fontSize: "1.25rem", fontWeight: 800, color: "var(--ink)", letterSpacing: "-0.02em", fontFamily: "var(--font)" }}>
            CollaBoard
          </span>
          <span style={{ fontSize: "0.7rem", fontWeight: 600, color: "var(--blue)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
            Pizarra
          </span>
        </div>
      </Link>
      <div className="topbar-middle">{children}</div>
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
        {/* Botón para navegar al módulo de Pixels (Wplace) */}
        <a
          href={pixelsUrl}
          id="nav-to-pixels-btn"
          className="btn btn-small"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "0.35rem",
            backgroundColor: "#EEF2FF",
            color: "#4F46E5",
            borderColor: "#C7D2FE",
            fontWeight: 600,
            textDecoration: "none",
          }}
          title="Ir al lienzo colaborativo de Pixels (Wplace)"
        >
          <span>🎨</span>
          <span>Pixels Wplace ↗</span>
        </a>

        {user && (
          <div className="topbar-user">
            <Avatar id={user.id} name={user.name} size={30} />
            <span className="topbar-name">{user.name}</span>
            <button type="button" className="btn btn-small btn-quiet" onClick={signOut}>
              Cerrar sesión
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
