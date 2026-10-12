/**
 * LOGIN DE DESARROLLO.
 *
 * Mientras el módulo de auth no esté integrado, permite entrar con cualquier
 * nombre usando POST /dev/token del backend (requiere AUTH_DEV_MODE=true).
 * Cuando el login real esté listo, esta página se reemplaza por la suya:
 * lo único que debe hacer al iniciar sesión es useAuth.getState().setSession(token)
 * y navegar a `next`.
 */
import { useState, type FormEvent } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router-dom";

import { safeNext } from "../auth/safeNext";
import { useAuth } from "../auth/authStore";
import { devAuthApi } from "../lib/boardsApi";

const DEV_LOGIN = (import.meta.env.VITE_DEV_LOGIN ?? "true") === "true";

function slug(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function LoginPage() {
  const token = useAuth((s) => s.token);
  const setSession = useAuth((s) => s.setSession);
  const [params] = useSearchParams();
  const next = safeNext(params.get("next"));
  const navigate = useNavigate();

  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (token) return <Navigate to={next} replace />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    const clean = name.trim();
    const id = slug(clean);
    if (!id) {
      setError("Escribe tu nombre.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { access_token } = await devAuthApi.token(id, clean);
      setSession(access_token);
      navigate(next, { replace: true });
    } catch (err) {
      setError(
        (err as { status?: number }).status === 404
          ? "El backend no tiene activado el login de desarrollo (AUTH_DEV_MODE=true)."
          : (err as Error).message,
      );
      setBusy(false);
    }
  }

  return (
    <main className="center-page">
      <div className="panel login-panel">
        <h1 className="hand-title">Pizarra</h1>
        {DEV_LOGIN ? (
          <form onSubmit={submit} className="stack">
            <p className="muted">
              Entrada de desarrollo: escribe un nombre y entras como ese usuario. Abre otra
              ventana privada con otro nombre para probar cómo se comparte un tablero.
            </p>
            <label className="field">
              <span>Tu nombre</span>
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Ej. Ana Gómez"
                maxLength={60}
                autoComplete="name"
              />
            </label>
            {error && <p className="form-error">{error}</p>}
            <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
              {busy ? "Entrando…" : "Entrar"}
            </button>
          </form>
        ) : (
          <p className="muted">Inicia sesión desde el módulo de autenticación del equipo.</p>
        )}
      </div>
    </main>
  );
}
