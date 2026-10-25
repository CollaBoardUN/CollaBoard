"use client";

/**
 * "Tus tableros". La lista llega renderizada desde el servidor (SSR por
 * petición); aquí se hidratan los filtros, la búsqueda y las acciones. Tras cada
 * cambio se actualiza la vista local y se pide al servidor la versión fresca.
 */
import { useMemo, useState, type ReactNode } from "react";

import type { NotificationList } from "@/core/domain/notifications";
import type { Board } from "@/core/domain/types";
import { toast } from "@/core/stores/toastStore";
import { useApis, useSessionUser } from "../AppContext";
import { ShareDialog } from "../board/ShareDialog";
import { BoardNameDialog } from "../common/BoardNameDialog";
import { ConfirmDialog } from "../common/ConfirmDialog";
import { TopBar } from "../common/TopBar";
import { useNavigation } from "../navigation";
import { BoardCard, type BoardAction } from "./BoardCard";

type Dialog = { kind: "create" } | { kind: BoardAction; board: Board } | null;
type Filter = "all" | "mine" | "shared";

const byUpdated = (a: Board, b: Board) => b.updated_at.localeCompare(a.updated_at);

const FILTERS: readonly (readonly [Filter, string])[] = [
  ["all", "Todos"],
  ["mine", "Creados por mí"],
  ["shared", "Compartidos conmigo"],
];

interface DashboardViewProps {
  initialBoards: Board[];
  initialInbox?: NotificationList | null;
  signOut?: ReactNode;
}

export function DashboardView({ initialBoards, initialInbox, signOut }: DashboardViewProps) {
  const { boards: boardsApi } = useApis();
  const user = useSessionUser();
  const nav = useNavigation();
  const [boards, setBoards] = useState(initialBoards);
  const [serverBoards, setServerBoards] = useState(initialBoards);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");

  // Si el servidor vuelve a renderizar con datos nuevos, esos mandan.
  if (initialBoards !== serverBoards) {
    setServerBoards(initialBoards);
    setBoards(initialBoards);
  }

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return boards.filter((b) => {
      if (filter === "mine" && b.my_role !== "owner") return false;
      if (filter === "shared" && b.my_role === "owner") return false;
      return !q || b.name.toLowerCase().includes(q);
    });
  }, [boards, filter, query]);

  const close = () => setDialog(null);
  const createButton = (label: string) => (
    <button type="button" className="btn btn-primary" onClick={() => setDialog({ kind: "create" })}>
      {label}
    </button>
  );

  return (
    <>
      <TopBar initialInbox={initialInbox} signOut={signOut} />
      <main className="page">
        <div className="page-head">
          <div>
            <h1>Tus tableros</h1>
            <p className="muted page-sub">
              Hola, {user.name}. {boards.length === 1 ? "Tienes 1 tablero." : `Tienes ${boards.length} tableros.`}
            </p>
          </div>
          {createButton("Nuevo tablero")}
        </div>

        {boards.length > 0 && (
          <div className="toolbar">
            <div className="tabs" role="tablist" aria-label="Filtrar tableros">
              {FILTERS.map(([key, label]) => (
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

        {boards.length === 0 && (
          <div className="empty">
            <p className="hand-title hand-small">Aquí aparecerán tus tableros</p>
            <p className="muted">Crea uno para empezar a dibujar, o pide a tu equipo un link de invitación.</p>
            {createButton("Crear mi primer tablero")}
          </div>
        )}

        {boards.length > 0 && visible.length === 0 && <p className="muted">Ningún tablero coincide con ese filtro.</p>}

        {visible.length > 0 && (
          <ul className="board-grid" aria-label="Tableros">
            {visible.map((b) => (
              <li key={b.id}>
                <BoardCard board={b} onAction={(kind, board) => setDialog({ kind, board })} />
              </li>
            ))}
          </ul>
        )}
      </main>

      {dialog?.kind === "create" && (
        <BoardNameDialog
          title="Nuevo tablero"
          submitLabel="Crear tablero"
          onClose={close}
          onSubmit={async (name) => {
            const board = await boardsApi.create(name);
            setBoards((list) => [board, ...list]);
            toast.ok("Tablero creado");
            nav.push(`/boards/${board.id}`);
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
            const updated = await boardsApi.rename(dialog.board.id, name);
            setBoards((list) => list.map((b) => (b.id === updated.id ? updated : b)).sort(byUpdated));
            toast.ok("Nombre guardado");
            nav.refresh();
          }}
        />
      )}

      {dialog?.kind === "share" && <ShareDialog board={dialog.board} onClose={close} onMembersChange={() => nav.refresh()} />}

      {dialog?.kind === "delete" && (
        <ConfirmDialog
          title="¿Borrar este tablero?"
          confirmLabel="Borrar tablero"
          onClose={close}
          onConfirm={async () => {
            await boardsApi.remove(dialog.board.id);
            setBoards((list) => list.filter((b) => b.id !== dialog.board.id));
            toast.ok("Tablero borrado");
            nav.refresh();
          }}
        >
          <p>
            Se borrará <strong>{dialog.board.name}</strong> con todo su contenido, y nadie más podrá abrirlo. Esto no se
            puede deshacer.
          </p>
        </ConfirmDialog>
      )}

      {dialog?.kind === "leave" && (
        <ConfirmDialog
          title="¿Salir del tablero?"
          confirmLabel="Salir del tablero"
          onClose={close}
          onConfirm={async () => {
            await boardsApi.removeMember(dialog.board.id, user.id);
            setBoards((list) => list.filter((b) => b.id !== dialog.board.id));
            toast.ok("Saliste del tablero");
            nav.refresh();
          }}
        >
          <p>
            Dejarás de ver <strong>{dialog.board.name}</strong>. Para volver necesitarás un link nuevo del dueño.
          </p>
        </ConfirmDialog>
      )}
    </>
  );
}
