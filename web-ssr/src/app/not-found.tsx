import Link from "next/link";

export default function NotFound() {
  return (
    <main className="center-page">
      <div className="panel">
        <h1>Esta página no existe</h1>
        <Link href="/" className="btn btn-primary">
          Ir a mis tableros
        </Link>
      </div>
    </main>
  );
}
