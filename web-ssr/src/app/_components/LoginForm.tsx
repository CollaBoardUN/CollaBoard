"use client";

import Link from "next/link";
import { useActionState } from "react";

import { loginAction, type AuthFormState } from "@/app/actions/session";
import { PasswordField } from "./PasswordField";

const initialState: AuthFormState = { error: null, fields: {} };

/** Funciona incluso sin JavaScript: es un `<form>` que envía a una Server Action. */
export function LoginForm({ next }: { next: string }) {
  const [state, action, pending] = useActionState(loginAction, initialState);

  return (
    <form action={action} className="stack auth-form">
      <input type="hidden" name="next" value={next} />
      <label className="field" htmlFor="login-email">
        <span>Correo electrónico</span>
        <input
          id="login-email"
          name="email"
          type="email"
          autoComplete="email"
          required
          maxLength={255}
          placeholder="correo@ejemplo.com"
          defaultValue={state.fields.email}
        />
      </label>
      <PasswordField id="login-password" name="password" label="Contraseña" autoComplete="current-password" />
      {state.error && (
        <p className="form-error" role="alert">
          {state.error}
        </p>
      )}
      <button type="submit" className="btn btn-primary btn-block" disabled={pending}>
        {pending ? "Iniciando sesión…" : "Iniciar sesión"}
      </button>
      <p className="auth-switch muted">
        ¿Aún no tienes cuenta? <Link href={`/register?next=${encodeURIComponent(next)}`}>Regístrate</Link>
      </p>
    </form>
  );
}
