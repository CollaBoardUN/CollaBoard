import { useState, type FormEvent } from "react";

import { Modal } from "./Modal";

interface Props {
  title: string;
  submitLabel: string;
  initialName?: string;
  onSubmit: (name: string) => Promise<void>;
  onClose: () => void;
}

/** Diálogo para crear o renombrar un tablero. */
export function BoardNameDialog({ title, submitLabel, initialName = "", onSubmit, onClose }: Props) {
  const [name, setName] = useState(initialName);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const trimmed = name.trim();

  async function handle(e: FormEvent) {
    e.preventDefault();
    if (!trimmed) {
      setError("Escribe un nombre para el tablero.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit(trimmed);
      onClose();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <Modal title={title} onClose={onClose}>
      <form onSubmit={handle} className="stack">
        <label className="field">
          <span>Nombre</span>
          <input
            data-autofocus
            value={name}
            maxLength={120}
            onChange={(e) => setName(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
            placeholder="Ej. Lluvia de ideas del sprint"
            aria-invalid={error ? true : undefined}
          />
        </label>
        {error && <p className="form-error">{error}</p>}
        <div className="actions">
          <button type="button" className="btn btn-quiet" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy || !trimmed}>
            {busy ? "Guardando…" : submitLabel}
          </button>
        </div>
      </form>
    </Modal>
  );
}
