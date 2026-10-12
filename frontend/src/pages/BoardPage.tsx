/**
 * Vista de un tablero. La Persona 1 se encarga de la cabecera (nombre, rol,
 * compartir). El lienzo lo pone la Persona 2 dentro de <BoardCanvasSlot>:
 * recibe el tablero y `canEdit` para desactivar las herramientas a los viewers.
 */
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";

import { BoardNameDialog } from "../components/BoardNameDialog";
import { RoleBadge } from "../components/RoleBadge";
import { ShareDialog } from "../components/ShareDialog";
import { TopBar } from "../components/TopBar";
import { toast } from "../components/toastStore";
import { ApiError } from "../lib/api";
import { boardsApi } from "../lib/boardsApi";
import type { Board } from "../lib/types";
import { useBoards } from "../stores/boardsStore";

export interface BoardCanvasProps {
  board: Board;
  canEdit: boolean;
}

/** Lugar reservado para el canvas (Persona 2) y el tiempo real (Persona 3). */
function BoardCanvasSlot({ board, canEdit }: BoardCanvasProps) {
  return (
    <div className="canvas-slot" data-board-id={board.id}>
      <p className="hand-title hand-small">El lienzo va aquí</p>
      <p className="muted">
        {canEdit
          ? "Tienes permiso para dibujar en este tablero."
          : "Estás en modo solo lectura: puedes mirar, pero no dibujar."}
      </p>
    </div>
  );
}

export function BoardPage() {
  const { boardId = "" } = useParams();
  const renameInStore = useBoards((s) => s.rename);
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

      <BoardCanvasSlot board={board} canEdit={board.my_role !== "viewer"} />

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
