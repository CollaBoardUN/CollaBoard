import Link from "next/link";

export default function BoardNotFound() {
  return (
    <main className="center-page">
      <div className="panel">
        <h1>No encontramos este tablero</h1>
        <p className="muted">
          Puede que lo hayan borrado o que no tengas acceso. Pide un link de invitación al dueño.
        </p>
        <Link href="/" className="btn btn-primary">
          Ir a mis tableros
        </Link>
      </div>
    </main>
  );
}
