import type { ReactNode } from "react";
import { Link } from "react-router-dom";

interface Props {
  heading: string;
  subheading: string;
  children: ReactNode;
}

/** Reutiliza el panel, bordes de aluminio y tipografías existentes de CollaBoard. */
export function AuthShell({ heading, subheading, children }: Props) {
  return (
    <main className="center-page auth-page">
      <section className="panel login-panel auth-panel" aria-label={heading}>
        <Link to="/" className="auth-brand" aria-label="Ir a Pizarra">
          <img src="/favicon.svg" width={34} height={34} alt="" />
          <span className="hand-title">Pizarra</span>
        </Link>
        <div className="auth-heading">
          <h1>{heading}</h1>
          <p className="muted">{subheading}</p>
        </div>
        {children}
      </section>
    </main>
  );
}
