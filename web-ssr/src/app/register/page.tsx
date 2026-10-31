import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { safeNext } from "@/core/lib/safeNext";
import { getSession } from "@/server/dal";
import { AuthShell } from "../_components/AuthShell";
import { RegisterForm } from "../_components/RegisterForm";

export const metadata: Metadata = { title: "Crear cuenta" };

export default async function RegisterPage({ searchParams }: PageProps<"/register">) {
  const params = await searchParams;
  const next = safeNext(typeof params.next === "string" ? params.next : null);
  // Si Auth no responde, se muestra igual el formulario (el error aparecerá al enviarlo).
  if (await getSession().catch(() => null)) redirect(next);

  return (
    <AuthShell heading="Crear una cuenta" subheading="Regístrate para crear y compartir pizarras.">
      <RegisterForm next={next} />
    </AuthShell>
  );
}
