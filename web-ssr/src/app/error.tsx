"use client";

import Link from "next/link";

/** Error inesperado al renderizar (p. ej. un servicio caído): se ofrece reintentar. */
export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="center-page">
      <div className="panel">
        <h1>Algo falló</h1>
        <p className="muted">
          No pudimos cargar esta página. Puede que un servicio no esté disponible en este momento.
        </p>
        {error.digest && <p className="muted small">Código: {error.digest}</p>}
        <div className="actions">
          <Link href="/" className="btn btn-quiet">
            Ir a mis tableros
          </Link>
          <button type="button" className="btn btn-primary" onClick={reset}>
            Reintentar
          </button>
        </div>
      </div>
    </main>
  );
}
