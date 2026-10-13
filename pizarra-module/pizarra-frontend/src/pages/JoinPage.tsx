import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import { TopBar } from "../components/TopBar";
import { toast } from "../components/toastStore";
import { boardsApi } from "../lib/boardsApi";
import { ROLE_HINT, ROLE_LABEL } from "../lib/format";
import type { InvitePreview } from "../lib/types";
import { useBoards } from "../stores/boardsStore";

/** /join/:token — vista de "unirse por link". Exige sesión (ver App.tsx). */
export function JoinPage() {
  const { token = "" } = useParams();
  const navigate = useNavigate();
  const reloadBoards = useBoards((s) => s.load);
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);

  useEffect(() => {
    let alive = true;
    boardsApi
      .previewInvite(token)
      .then((p) => alive && setPreview(p))
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [token]);

  async function join() {
    setJoining(true);
    try {
      const result = await boardsApi.acceptInvite(token);
      void reloadBoards();
      toast.ok(`Te uniste: ${ROLE_LABEL[result.role].toLowerCase()}`);
      navigate(`/boards/${result.board_id}`, { replace: true });
    } catch (e) {
      setError((e as Error).message);
      setJoining(false);
    }
  }

  // Ya es viewer y el link es de editor: puede subir de permiso.
  const upgrade =
    preview?.already_member && preview.current_role === "viewer" && preview.role === "editor";

  return (
    <>
      <TopBar />
      <main className="center-page">
        <div className="panel join-panel">
          {error ? (
            <>
              <h1>Este link no funciona</h1>
              <p className="muted">{error}. Pide al dueño del tablero un link nuevo.</p>
              <Link to="/" className="btn btn-quiet">
                Ir a mis tableros
              </Link>
            </>
          ) : !preview ? (
            <p className="muted">Revisando la invitación…</p>
          ) : (
            <>
              <p className="muted">Te invitaron al tablero</p>
              <h1 className="hand-title">{preview.board_name}</h1>
              {preview.already_member && !upgrade ? (
                <>
                  <p>Ya eres miembro de este tablero.</p>
                  <Link to={`/boards/${preview.board_id}`} className="btn btn-primary btn-block">
                    Abrir tablero
                  </Link>
                </>
              ) : (
                <>
                  <p className="join-role">
                    <strong>{ROLE_LABEL[preview.role]}</strong>
                    <span className="muted">{ROLE_HINT[preview.role]}</span>
                  </p>
                  <button
                    type="button"
                    className="btn btn-primary btn-block"
                    onClick={join}
                    disabled={joining}
                  >
                    {joining ? "Uniéndote…" : upgrade ? "Obtener permiso de edición" : "Unirme al tablero"}
                  </button>
                </>
              )}
            </>
          )}
        </div>
      </main>
    </>
  );
}
