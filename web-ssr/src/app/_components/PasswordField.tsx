"use client";

import { Eye, EyeOff } from "lucide-react";
import { useState } from "react";

interface Props {
  id: string;
  name: string;
  label: string;
  autoComplete: "current-password" | "new-password";
  minLength?: number;
  hint?: string;
  /** Comparte el estado "mostrar" entre dos campos (contraseña y confirmación). */
  visible?: boolean;
  onToggle?: () => void;
  toggle?: boolean;
}

export function PasswordField({ id, name, label, autoComplete, minLength, hint, visible, onToggle, toggle = true }: Props) {
  const [own, setOwn] = useState(false);
  const shown = visible ?? own;
  const flip = onToggle ?? (() => setOwn((v) => !v));
  return (
    <label className="field" htmlFor={id}>
      <span>{label}</span>
      <span className="auth-password-wrap">
        <input
          id={id}
          name={name}
          type={shown ? "text" : "password"}
          autoComplete={autoComplete}
          required
          minLength={minLength}
          maxLength={128}
        />
        {toggle && (
          <button
            type="button"
            className="auth-visibility"
            aria-label={shown ? "Ocultar contraseña" : "Mostrar contraseña"}
            aria-pressed={shown}
            onClick={flip}
          >
            {shown ? <EyeOff size={18} /> : <Eye size={18} />}
          </button>
        )}
      </span>
      {hint && <span className="muted auth-hint">{hint}</span>}
    </label>
  );
}
