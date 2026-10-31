"use server";

/**
 * Inicio y cierre de sesión de la web (Server Actions).
 *
 * El formulario se envía al servidor web, que llama a Auth (Go) por el gateway y
 * guarda el JWT en una cookie HttpOnly. El token nunca pasa por el JavaScript del
 * navegador. Next.js compara `Origin` con el host antes de ejecutar la acción
 * (protección CSRF incluida en las Server Actions).
 */
import { redirect } from "next/navigation";

import { safeNext } from "@/core/lib/safeNext";
import { GatewayError, gatewayJson } from "@/server/gateway";
import { currentRequestId } from "@/server/requestId";
import { clearSessionCookie, writeSessionCookie } from "@/server/session";

export interface AuthFormState {
  error: string | null;
  /** Valores para no vaciar el formulario si algo falla (nunca la contraseña). */
  fields: { name?: string; email?: string };
}

interface AuthSession {
  access_token: string;
  token_type: string;
}

const text = (form: FormData, key: string) => {
  const value = form.get(key);
  return typeof value === "string" ? value : "";
};

function failure(error: unknown, fields: AuthFormState["fields"], fallback: string): AuthFormState {
  if (error instanceof GatewayError) return { error: error.message, fields };
  return { error: fallback, fields };
}

export async function loginAction(_previous: AuthFormState, form: FormData): Promise<AuthFormState> {
  const email = text(form, "email").trim();
  const password = text(form, "password");
  const next = safeNext(text(form, "next"));
  const fields = { email };
  if (!email || !password) return { error: "Escribe tu correo y tu contraseña.", fields };

  try {
    const session = await gatewayJson<AuthSession>("/api/auth/login", {
      method: "POST",
      body: { email, password },
      requestId: await currentRequestId(),
    });
    await writeSessionCookie(session.access_token);
  } catch (error) {
    return failure(error, fields, "No fue posible iniciar sesión.");
  }
  redirect(next);
}

export async function registerAction(_previous: AuthFormState, form: FormData): Promise<AuthFormState> {
  const name = text(form, "name").trim();
  const email = text(form, "email").trim();
  const password = text(form, "password");
  const confirm = text(form, "confirm_password");
  const next = safeNext(text(form, "next"));
  const fields = { name, email };

  if (name.length < 2) return { error: "Escribe tu nombre (mínimo 2 caracteres).", fields };
  if (password !== confirm) return { error: "Las contraseñas no coinciden.", fields };
  if (new TextEncoder().encode(password).length < 12) {
    return { error: "Utiliza una contraseña de al menos 12 caracteres.", fields };
  }

  try {
    const session = await gatewayJson<AuthSession>("/api/auth/register", {
      method: "POST",
      body: { name, email, password, confirm_password: confirm },
      requestId: await currentRequestId(),
    });
    await writeSessionCookie(session.access_token);
  } catch (error) {
    return failure(error, fields, "No fue posible crear tu cuenta.");
  }
  redirect(next);
}

export async function logoutAction(): Promise<void> {
  await clearSessionCookie();
  redirect("/login");
}
