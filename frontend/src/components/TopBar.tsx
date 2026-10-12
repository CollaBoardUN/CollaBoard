import type { ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";

import { useAuth } from "../auth/authStore";
import { useBoards } from "../stores/boardsStore";
import { Avatar } from "./Avatar";

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

  return (
    <header className="topbar">
      <Link to="/" className="brand">
        <img src="/favicon.svg" alt="" width="26" height="26" />
        Pizarra
      </Link>
      <div className="topbar-middle">{children}</div>
      {user && (
        <div className="topbar-user">
          <Avatar id={user.id} name={user.name} size={30} />
          <span className="topbar-name">{user.name}</span>
          <button type="button" className="btn btn-small btn-quiet" onClick={signOut}>
            Cerrar sesión
          </button>
        </div>
      )}
    </header>
  );
}
