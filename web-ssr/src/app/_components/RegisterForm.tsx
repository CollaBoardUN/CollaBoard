"use client";

import Link from "next/link";
import { useActionState, useState } from "react";

import { registerAction, type AuthFormState } from "@/app/actions/session";
import { PasswordField } from "./PasswordField";

const initialState: AuthFormState = { error: null, fields: {} };

export function RegisterForm({ next }: { next: string }) {
  const [state, action, pending] = useActionState(registerAction, initialState);
  const [showPassword, setShowPassword] = useState(false);

  return (
    <form action={action} className="stack auth-form">
      <input type="hidden" name="next" value={next} />
      <label className="field" htmlFor="register-name">
        <span>Nombre</span>
        <input
          id="register-name"
          name="name"
          type="text"
          autoComplete="name"
          required
          minLength={2}
          maxLength={120}
          placeholder="Ana Gómez"
          defaultValue={state.fields.name}
        />
      </label>
      <label className="field" htmlFor="register-email">
        <span>Correo electrónico</span>
        <input
          id="register-email"
          name="email"
          type="email"
          autoComplete="email"
          required
          maxLength={255}
          placeholder="correo@ejemplo.com"
          defaultValue={state.fields.email}
        />
      </label>
      <PasswordField
        id="register-password"
        name="password"
        label="Contraseña"
        autoComplete="new-password"
        minLength={12}
        hint="Mínimo 12 caracteres. No compartas tu contraseña."
        visible={showPassword}
        onToggle={() => setShowPassword((v) => !v)}
      />
      <PasswordField
        id="register-confirm"
        name="confirm_password"
        label="Confirmar contraseña"
        autoComplete="new-password"
        minLength={12}
        visible={showPassword}
        toggle={false}
      />
      {state.error && (
        <p className="form-error" role="alert">
          {state.error}
        </p>
      )}
      <button type="submit" className="btn btn-primary btn-block" disabled={pending}>
        {pending ? "Creando cuenta…" : "Crear cuenta"}
      </button>
      <p className="auth-switch muted">
        ¿Ya tienes cuenta? <Link href={`/login?next=${encodeURIComponent(next)}`}>Inicia sesión</Link>
      </p>
    </form>
  );
}
