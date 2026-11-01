"use client";

/**
 * Vista interactiva de un tablero: se hidrata sobre la cabecera que ya llegó
 * renderizada del servidor y agrega lienzo, presencia, chat y compartir.
 *
 * El lienzo llega como `canvas` porque cada presentación lo carga a su manera
 * (la web lo importa solo en el navegador; Konva no puede ejecutarse en el servidor).
 */
import { MessageSquare } from "lucide-react";
import { useCallback, useState, type ReactNode } from "react";

import type { ChatPage } from "@/core/domain/chat";
import type { NotificationList } from "@/core/domain/notifications";
import type { Board } from "@/core/domain/types";
import { toast } from "@/core/stores/toastStore";
import { useApis } from "../AppContext";
import { ChatPanel } from "../chat/ChatPanel";
import { BoardNameDialog } from "../common/BoardNameDialog";
import { PresenceBar } from "../common/PresenceBar";
import { RemoteCursors } from "../common/RemoteCursors";
import { RoleBadge } from "../common/RoleBadge";
import { TopBar } from "../common/TopBar";
import { Toolbar } from "../canvas/Toolbar";
import { NavLink } from "../navigation";
import { SaveIndicator } from "./SaveIndicator";
import { ShareDialog } from "./ShareDialog";
import { useBoardRealtime, type InitialCanvas } from "./useBoardRealtime";

interface BoardWorkspaceProps {
  board: Board;
  canvas: ReactNode;
  initialCanvas?: InitialCanvas;
  initialChat?: ChatPage | null;
  initialInbox?: NotificationList | null;
  signOut?: ReactNode;
}

export function BoardWorkspace({ board: initialBoard, canvas, initialCanvas, initialChat, initialInbox, signOut }: BoardWorkspaceProps) {
  const { boards } = useApis();
  const [board, setBoard] = useState(initialBoard);
  const [dialog, setDialog] = useState<"share" | "rename" | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [chatUnread, setChatUnread] = useState(0);
  const onUnreadChange = useCallback((n: number) => setChatUnread(n), []);

  useBoardRealtime(board.id, initialCanvas);

  const isOwner = board.my_role === "owner";
  const canDraw = board.my_role !== "viewer";

  return (
    <div className={chatOpen ? "board-layout board-chat-open" : "board-layout"}>
      <TopBar initialInbox={initialInbox} signOut={signOut} onOpenNotifications={() => setChatOpen(false)}>
        <div className="board-head">
          <NavLink href="/" className="back" aria-label="Volver a mis tableros">
            ←
          </NavLink>
          {isOwner ? (
            <button type="button" className="board-name-btn" onClick={() => setDialog("rename")} title="Renombrar">
              {board.name}
            </button>
          ) : (
            <h1 className="board-name">{board.name}</h1>
          )}
          <RoleBadge role={board.my_role} />
          <PresenceBar />
          <SaveIndicator />
          <span className="board-head-actions">
            <button
              type="button"
              className={chatOpen ? "btn btn-small btn-chat btn-chat-on" : "btn btn-small btn-chat"}
              aria-pressed={chatOpen}
              onClick={() => setChatOpen((v) => !v)}
            >
              <MessageSquare size={15} aria-hidden="true" />
              Chat
              {chatUnread > 0 && (
                <span className="badge badge-inline" aria-label={`${chatUnread} sin leer`}>
                  {chatUnread}
                </span>
              )}
            </button>
            <button type="button" className="btn btn-small btn-primary" onClick={() => setDialog("share")}>
              {isOwner ? "Compartir" : `Miembros (${board.member_count})`}
            </button>
          </span>
        </div>
      </TopBar>

      {canvas}
      <RemoteCursors />
      {canDraw ? (
        <Toolbar />
      ) : (
        <p className="readonly-note" role="note">
          Tienes acceso de solo lectura: puedes mirar y conversar en el chat.
        </p>
      )}

      <ChatPanel
        boardId={board.id}
        open={chatOpen}
        onClose={() => setChatOpen(false)}
        onUnreadChange={onUnreadChange}
        initialPage={initialChat}
      />

      {dialog === "share" && (
        <ShareDialog
          board={board}
          onClose={() => setDialog(null)}
          onMembersChange={(n) => setBoard((b) => ({ ...b, member_count: n }))}
        />
      )}
      {dialog === "rename" && (
        <BoardNameDialog
          title="Renombrar tablero"
          submitLabel="Guardar nombre"
          initialName={board.name}
          onClose={() => setDialog(null)}
          onSubmit={async (name) => {
            const updated = await boards.rename(board.id, name);
            setBoard((b) => ({ ...b, name: updated.name, updated_at: updated.updated_at }));
            toast.ok("Nombre guardado");
          }}
        />
      )}
    </div>
  );
}
