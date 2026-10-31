"use client";

import { useState, type ReactNode } from "react";

import { Modal } from "./Modal";

interface Props {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}

export function ConfirmDialog({ title, children, confirmLabel, onConfirm, onClose }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      onClose();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <Modal title={title} onClose={onClose}>
      <div className="stack">
        <div className="prose">{children}</div>
        {error && <p className="form-error">{error}</p>}
        <div className="actions">
          <button type="button" className="btn btn-quiet" onClick={onClose} data-autofocus>
            Cancelar
          </button>
          <button type="button" className="btn btn-danger" onClick={confirm} disabled={busy}>
            {busy ? "Un momento…" : confirmLabel}
          </button>
        </div>
      </div>
    </Modal>
  );
}
