import type { Metadata } from "next";

import { getInbox, listMyBoards, requireSession } from "@/server/dal";
import { DashboardView } from "@/ui/dashboard/DashboardView";
import { AuthedPage } from "./_components/AuthedPage";
import { SignOutForm } from "./_components/SignOutForm";

export const metadata: Metadata = { title: "Tus tableros" };

// Datos privados por usuario: se renderiza en cada petición y nunca se cachea.
export const dynamic = "force-dynamic";

/**
 * Dashboard renderizado en el servidor: el HTML inicial ya trae los nombres
 * reales de los tableros del usuario (consulta a Colaboración por el gateway).
 */
export default async function DashboardPage() {
  const { user } = await requireSession("/");
  const [boards, inbox] = await Promise.all([listMyBoards(), getInbox("/")]);

  return (
    <AuthedPage user={user}>
      <DashboardView initialBoards={boards} initialInbox={inbox} signOut={<SignOutForm />} />
    </AuthedPage>
  );
}
