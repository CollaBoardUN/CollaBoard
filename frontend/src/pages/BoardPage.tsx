/**
 * Vista del tablero: cabecera, herramientas de dibujo y lienzo.
 */
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";

import { useAuth } from "../auth/authStore";
import { BoardNameDialog } from "../components/BoardNameDialog";
import { RoleBadge } from "../components/RoleBadge";
import { ShareDialog } from "../components/ShareDialog";
import { TopBar } from "../components/TopBar";
import { toast } from "../components/toastStore";
import { ApiError } from "../lib/api";
import { boardsApi } from "../lib/boardsApi";
import type { Board } from "../lib/types";
import { CanvasBoard } from "../presentation/components/canvas/CanvasBoard";
import { Toolbar } from "../presentation/components/toolbar/Toolbar";
import { useBoards } from "../stores/boardsStore";

export function BoardPage() {
  const { boardId = "" } = useParams();
  const renameInStore = useBoards((s) => s.rename);
  const authorId = useAuth((s) => s.user?.id ?? "local-user");
  const [board, setBoard] = useState<Board | null>(null);
  const [error, setError] = useState<{ status: number; message: string } | null>(null);
  const [dialog, setDialog] = useState<"share" | "rename" | null>(null);

  useEffect(() => {
    let alive = true;
    boardsApi
      .get(boardId)
      .then((b) => alive && setBoard(b))
      .catch((e: ApiError) => alive && setError({ status: e.status ?? 0, message: e.message }));
    return () => {
      alive = false;
    };
  }, [boardId]);

  if (error) {
    return (
      <>
        <TopBar />
        <main className="center-page">
          <div className="panel">
            <h1>{error.status === 404 ? "No encontramos este tablero" : "Algo falló"}</h1>
            <p className="muted">
              {error.status === 404
                ? "Puede que lo hayan borrado o que no tengas acceso. Pide un link de invitación al dueño."
                : error.message}
            </p>
            <Link to="/" className="btn btn-primary">
              Ir a mis tableros
            </Link>
          </div>
        </main>
      </>
    );
  }

  if (!board) {
    return (
      <>
        <TopBar />
        <main className="page">
          <p className="muted">Abriendo tablero…</p>
        </main>
      </>
    );
  }

  const isOwner = board.my_role === "owner";

  return (
    <div className="board-layout">
      <TopBar>
        <div className="board-head">
          <Link to="/" className="back" aria-label="Volver a mis tableros">
            ←
          </Link>
          {isOwner ? (
            <button
              type="button"
              className="board-name-btn"
              onClick={() => setDialog("rename")}
              title="Renombrar"
            >
              {board.name}
            </button>
          ) : (
            <span className="board-name">{board.name}</span>
          )}
          <RoleBadge role={board.my_role} />
          <button type="button" className="btn btn-small btn-primary" onClick={() => setDialog("share")}>
            {isOwner ? "Compartir" : `Miembros (${board.member_count})`}
          </button>
        </div>
      </TopBar>

      <CanvasBoard authorId={authorId} />
      <Toolbar />

      {dialog === "share" && (
        <ShareDialog
          board={board}
          onClose={() => setDialog(null)}
          onMembersChange={(n) => setBoard({ ...board, member_count: n })}
        />
      )}
      {dialog === "rename" && (
        <BoardNameDialog
          title="Renombrar tablero"
          submitLabel="Guardar nombre"
          initialName={board.name}
          onClose={() => setDialog(null)}
          onSubmit={async (name) => {
            await renameInStore(board.id, name);
            setBoard({ ...board, name });
            toast.ok("Nombre guardado");
          }}
        />
      )}
    </div>
  );
}
