import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

import { useAuth } from "../auth/authStore";
import { BoardCard, type BoardAction } from "../components/BoardCard";
import { BoardNameDialog } from "../components/BoardNameDialog";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { ShareDialog } from "../components/ShareDialog";
import { TopBar } from "../components/TopBar";
import { toast } from "../components/toastStore";
import type { Board } from "../lib/types";
import { useBoards } from "../stores/boardsStore";

type Dialog = { kind: "create" } | { kind: BoardAction; board: Board } | null;
type Filter = "all" | "mine" | "shared";

export function DashboardPage() {
  const { boards, status, error, load, create, rename, remove, leave } = useBoards();
  const user = useAuth((s) => s.user);
  const navigate = useNavigate();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");

  useEffect(() => {
    void load();
  }, [load]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return boards.filter((b) => {
      if (filter === "mine" && b.my_role !== "owner") return false;
      if (filter === "shared" && b.my_role === "owner") return false;
      return !q || b.name.toLowerCase().includes(q);
    });
  }, [boards, filter, query]);

  const close = () => setDialog(null);

  return (
    <>
      <TopBar />
      <main className="page">
        <div className="page-head">
          <h1>Tus tableros</h1>
          <button type="button" className="btn btn-primary" onClick={() => setDialog({ kind: "create" })}>
            Nuevo tablero
          </button>
        </div>

        {boards.length > 0 && (
          <div className="toolbar">
            <div className="tabs" role="tablist" aria-label="Filtrar tableros">
              {(
                [
                  ["all", "Todos"],
                  ["mine", "Creados por mí"],
                  ["shared", "Compartidos conmigo"],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  aria-selected={filter === key}
                  className={filter === key ? "tab tab-on" : "tab"}
                  onClick={() => setFilter(key)}
                >
                  {label}
                </button>
              ))}
            </div>
            <input
              type="search"
              className="search"
              placeholder="Buscar por nombre"
              aria-label="Buscar tableros"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        )}

        {status === "loading" && <p className="muted">Cargando tableros…</p>}

        {status === "error" && (
          <div className="empty">
            <p>No se pudieron cargar los tableros: {error}</p>
            <button type="button" className="btn btn-quiet" onClick={() => load()}>
              Reintentar
            </button>
          </div>
        )}

        {status === "ready" && boards.length === 0 && (
          <div className="empty">
            <p className="hand-title hand-small">Aquí aparecerán tus tableros</p>
            <p className="muted">
              Crea uno para empezar a dibujar, o pide a tu equipo un link de invitación.
            </p>
            <button type="button" className="btn btn-primary" onClick={() => setDialog({ kind: "create" })}>
              Crear mi primer tablero
            </button>
          </div>
        )}

        {status === "ready" && boards.length > 0 && visible.length === 0 && (
          <p className="muted">Ningún tablero coincide con ese filtro.</p>
        )}

        {visible.length > 0 && (
          <div className="board-grid">
            {visible.map((b) => (
              <BoardCard key={b.id} board={b} onAction={(kind, board) => setDialog({ kind, board })} />
            ))}
          </div>
        )}
      </main>

      {dialog?.kind === "create" && (
        <BoardNameDialog
          title="Nuevo tablero"
          submitLabel="Crear tablero"
          onClose={close}
          onSubmit={async (name) => {
            const board = await create(name);
            toast.ok("Tablero creado");
            navigate(`/boards/${board.id}`);
          }}
        />
      )}

      {dialog?.kind === "rename" && (
        <BoardNameDialog
          title="Renombrar tablero"
          submitLabel="Guardar nombre"
          initialName={dialog.board.name}
          onClose={close}
          onSubmit={async (name) => {
            await rename(dialog.board.id, name);
            toast.ok("Nombre guardado");
          }}
        />
      )}

      {dialog?.kind === "share" && (
        <ShareDialog board={dialog.board} onClose={close} onMembersChange={() => load()} />
      )}

      {dialog?.kind === "delete" && (
        <ConfirmDialog
          title="¿Borrar este tablero?"
          confirmLabel="Borrar tablero"
          onClose={close}
          onConfirm={async () => {
            await remove(dialog.board.id);
            toast.ok("Tablero borrado");
          }}
        >
          <p>
            Se borrará <strong>{dialog.board.name}</strong> con todo su contenido, y nadie más podrá
            abrirlo. Esto no se puede deshacer.
          </p>
        </ConfirmDialog>
      )}

      {dialog?.kind === "leave" && user && (
        <ConfirmDialog
          title="¿Salir del tablero?"
          confirmLabel="Salir del tablero"
          onClose={close}
          onConfirm={async () => {
            await leave(dialog.board.id, user.id);
            toast.ok("Saliste del tablero");
          }}
        >
          <p>
            Dejarás de ver <strong>{dialog.board.name}</strong>. Para volver necesitarás un link
            nuevo del dueño.
          </p>
        </ConfirmDialog>
      )}
    </>
  );
}
