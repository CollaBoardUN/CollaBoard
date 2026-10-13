import { useState, type FormEvent } from "react";
import { Eye, EyeOff } from "lucide-react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router-dom";

import { safeNext } from "../auth/safeNext";
import { useAuth } from "../auth/authStore";
import { AuthShell } from "../components/AuthShell";
import { authApi } from "../lib/authApi";

export function RegisterPage() {
  const token = useAuth((s) => s.token);
  const setSession = useAuth((s) => s.setSession);
  const [params] = useSearchParams();
  const next = safeNext(params.get("next"));
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (token) return <Navigate to={next} replace />;

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    if (password !== confirm) {
      setError("Las contraseñas no coinciden.");
      return;
    }
    if (new TextEncoder().encode(password).length < 12) {
      setError("Utiliza una contraseña de al menos 12 bytes.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await authApi.register({
        name: name.trim(), email: email.trim(), password, confirm_password: confirm,
      });
      setSession(result.access_token);
      if (!useAuth.getState().token) throw new Error("El servidor devolvió un token inválido.");
      navigate(next, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "No fue posible crear tu cuenta.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell heading="Crear una cuenta" subheading="Regístrate para crear y compartir pizarras.">
      <form onSubmit={submit} className="stack auth-form">
        <label className="field" htmlFor="register-name">
          <span>Nombre</span>
          <input id="register-name" type="text" autoComplete="name" required minLength={2}
            maxLength={120} value={name} placeholder="Ana Gómez"
            onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field" htmlFor="register-email">
          <span>Correo electrónico</span>
          <input id="register-email" type="email" autoComplete="email" required maxLength={255}
            placeholder="correo@ejemplo.com" value={email}
            onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="field" htmlFor="register-password">
          <span>Contraseña</span>
          <span className="auth-password-wrap">
            <input id="register-password" type={showPassword ? "text" : "password"}
              autoComplete="new-password" required minLength={12} maxLength={128}
              value={password} onChange={(e) => setPassword(e.target.value)} />
            <button type="button" className="auth-visibility"
              aria-label={showPassword ? "Ocultar contraseña" : "Mostrar contraseña"}
              aria-pressed={showPassword} onClick={() => setShowPassword(!showPassword)}>
              {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
            </button>
          </span>
          <span className="muted auth-hint">Mínimo 12 caracteres. No compartas tu contraseña.</span>
        </label>
        <label className="field" htmlFor="register-confirm">
          <span>Confirmar contraseña</span>
          <input id="register-confirm" type={showPassword ? "text" : "password"}
            autoComplete="new-password" required minLength={12} maxLength={128}
            value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </label>
        {error && <p className="form-error" role="alert">{error}</p>}
        <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
          {busy ? "Creando cuenta…" : "Crear cuenta"}
        </button>
        <p className="auth-switch muted">¿Ya tienes cuenta?{" "}
          <Link to={`/login?next=${encodeURIComponent(next)}`}>Inicia sesión</Link>
        </p>
      </form>
    </AuthShell>
  );
}
