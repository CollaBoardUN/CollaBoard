import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { safeNext } from "@/core/lib/safeNext";
import { getSession } from "@/server/dal";
import { AuthShell } from "../_components/AuthShell";
import { LoginForm } from "../_components/LoginForm";

export const metadata: Metadata = { title: "Iniciar sesión" };

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const params = await searchParams;
  const next = safeNext(typeof params.next === "string" ? params.next : null);
  // Si Auth no responde, se muestra igual el formulario (el error aparecerá al enviarlo).
  if (await getSession().catch(() => null)) redirect(next);
  const expired = params.reason === "expired";

  return (
    <AuthShell heading="Iniciar sesión" subheading="Vuelve a tus tableros y sigue creando en equipo.">
      {expired && (
        <p className="notice" role="status">
          Tu sesión terminó. Inicia sesión de nuevo para continuar.
        </p>
      )}
      <LoginForm next={next} />
    </AuthShell>
  );
}
