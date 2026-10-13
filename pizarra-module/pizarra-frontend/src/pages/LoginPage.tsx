import { useState, type FormEvent } from "react";
import { Eye, EyeOff } from "lucide-react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router-dom";

import { safeNext } from "../auth/safeNext";
import { useAuth } from "../auth/authStore";
import { AuthShell } from "../components/AuthShell";
import { authApi } from "../lib/authApi";

export function LoginPage() {
  const token = useAuth((s) => s.token);
  const setSession = useAuth((s) => s.setSession);
  const [params] = useSearchParams();
  const next = safeNext(params.get("next"));
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (token) return <Navigate to={next} replace />;

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await authApi.login({ email: email.trim(), password });
      setSession(result.access_token);
      if (!useAuth.getState().token) throw new Error("El servidor devolvió un token inválido.");
      navigate(next, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "No fue posible iniciar sesión.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell heading="Iniciar sesión" subheading="Vuelve a tus tableros y sigue creando en equipo.">
      <form onSubmit={submit} className="stack auth-form">
        <label className="field" htmlFor="login-email">
          <span>Correo electrónico</span>
          <input id="login-email" type="email" autoComplete="email" required maxLength={255}
            placeholder="correo@ejemplo.com" value={email}
            onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="field" htmlFor="login-password">
          <span>Contraseña</span>
          <span className="auth-password-wrap">
            <input id="login-password" type={showPassword ? "text" : "password"}
              autoComplete="current-password" required value={password}
              onChange={(e) => setPassword(e.target.value)} />
            <button type="button" className="auth-visibility" aria-label={showPassword ? "Ocultar contraseña" : "Mostrar contraseña"}
              aria-pressed={showPassword} onClick={() => setShowPassword(!showPassword)}>
              {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
            </button>
          </span>
        </label>
        {error && <p className="form-error" role="alert">{error}</p>}
        <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
          {busy ? "Iniciando sesión…" : "Iniciar sesión"}
        </button>
        <p className="auth-switch muted">¿Aún no tienes cuenta?{" "}
          <Link to={`/register?next=${encodeURIComponent(next)}`}>Regístrate</Link>
        </p>
      </form>
    </AuthShell>
  );
}
