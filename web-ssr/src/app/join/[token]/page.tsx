import type { Metadata } from "next";
import Link from "next/link";

import { acceptInviteAction } from "@/app/actions/invites";
import { ROLE_HINT, ROLE_LABEL } from "@/core/lib/format";
import { previewInvite, requireSession } from "@/server/dal";
import { TopBar } from "@/ui/common/TopBar";
import { AuthedPage } from "../../_components/AuthedPage";
import { JoinForm } from "../../_components/JoinForm";
import { SignOutForm } from "../../_components/SignOutForm";

export const metadata: Metadata = { title: "Unirse a un tablero" };
export const dynamic = "force-dynamic";

/** Vista previa de la invitación renderizada en el servidor; aceptar es una Server Action. */
export default async function JoinPage({ params }: PageProps<"/join/[token]">) {
  const { token } = await params;
  const { user } = await requireSession(`/join/${encodeURIComponent(token)}`);
  const lookup = await previewInvite(token);

  let content;
  if (lookup.kind === "invalid") {
    content = (
      <>
        <h1>Este link no funciona</h1>
        <p className="muted">{lookup.message}. Pide al dueño del tablero un link nuevo.</p>
        <Link href="/" className="btn btn-quiet">
          Ir a mis tableros
        </Link>
      </>
    );
  } else {
    const { preview } = lookup;
    // Ya es viewer y el link es de editor: puede subir de permiso.
    const upgrade = preview.already_member && preview.current_role === "viewer" && preview.role === "editor";
    content = (
      <>
        <p className="muted">Te invitaron al tablero</p>
        <h1 className="hand-title">{preview.board_name}</h1>
        {preview.already_member && !upgrade ? (
          <>
            <p>Ya eres miembro de este tablero.</p>
            <Link href={`/boards/${encodeURIComponent(preview.board_id)}`} className="btn btn-primary btn-block">
              Abrir tablero
            </Link>
          </>
        ) : (
          <>
            <p className="join-role">
              <strong>{ROLE_LABEL[preview.role]}</strong>
              <span className="muted">{ROLE_HINT[preview.role]}</span>
            </p>
            <JoinForm
              action={acceptInviteAction.bind(null, token)}
              label={upgrade ? "Obtener permiso de edición" : "Unirme al tablero"}
            />
          </>
        )}
      </>
    );
  }

  return (
    <AuthedPage user={user}>
      <TopBar signOut={<SignOutForm />} />
      <main className="center-page">
        <div className="panel join-panel">{content}</div>
      </main>
    </AuthedPage>
  );
}
