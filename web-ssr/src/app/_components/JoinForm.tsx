"use client";

import { useActionState } from "react";

import type { JoinState } from "@/app/actions/invites";

interface JoinFormProps {
  /** Server Action ya ligada al token de la invitación (se liga en el servidor). */
  action: (previous: JoinState) => Promise<JoinState>;
  label: string;
}

export function JoinForm({ action, label }: JoinFormProps) {
  const [state, formAction, pending] = useActionState(action, { error: null });
  return (
    <form action={formAction} className="stack">
      {state.error && (
        <p className="form-error" role="alert">
          {state.error}
        </p>
      )}
      <button type="submit" className="btn btn-primary btn-block" disabled={pending}>
        {pending ? "Uniéndote…" : label}
      </button>
    </form>
  );
}
