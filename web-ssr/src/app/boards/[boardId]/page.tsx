import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { getBoard, getCanvasState, getChatFirstPage, getInbox, requireSession } from "@/server/dal";
import { BoardWorkspace } from "@/ui/board/BoardWorkspace";
import { AuthedPage } from "../../_components/AuthedPage";
import { BoardCanvas } from "../../_components/BoardCanvas";
import { SignOutForm } from "../../_components/SignOutForm";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: PageProps<"/boards/[boardId]">): Promise<Metadata> {
  const { boardId } = await params;
  const lookup = await getBoard(boardId);
  return { title: lookup.kind === "ok" ? lookup.board.name : "Tablero" };
}

/**
 * Tablero: el servidor resuelve permisos y metadatos (nombre, rol, miembros),
 * el último estado guardado y la primera página del chat. El navegador hidrata
 * el lienzo de Konva, el tiempo real y los paneles.
 */
export default async function BoardPage({ params }: PageProps<"/boards/[boardId]">) {
  const { boardId } = await params;
  const path = `/boards/${encodeURIComponent(boardId)}`;
  const { user } = await requireSession(path);

  const lookup = await getBoard(boardId);
  // Colaboración responde 404 también a quien no es miembro: no se revela si el tablero existe.
  if (lookup.kind !== "ok") notFound();
  const { board } = lookup;

  const [state, chat, inbox] = await Promise.all([getCanvasState(board.id), getChatFirstPage(board.id), getInbox(path)]);

  return (
    <AuthedPage user={user}>
      <BoardWorkspace
        board={board}
        canvas={<BoardCanvas authorId={user.id} readOnly={board.my_role === "viewer"} />}
        initialCanvas={state ? { elements: state.elements, savedAt: state.saved_at, seq: state.seq } : undefined}
        initialChat={chat}
        initialInbox={inbox}
        signOut={<SignOutForm />}
      />
      <noscript>
        <p className="noscript">Activa JavaScript para dibujar y conversar en este tablero.</p>
      </noscript>
    </AuthedPage>
  );
}
