import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { CollaBoardLogo } from "./CollaBoardLogo";

interface Props {
  heading: string;
  subheading: string;
  children: ReactNode;
}

/** Identidad visual compartida con Pizarra: no crea una SPA adicional. */
export function AuthShell({ heading, subheading, children }: Props) {
  return (
    <main className="center-page auth-page">
      <section className="panel login-panel auth-panel" aria-label={heading}>
        <Link to="/" className="auth-brand" aria-label="Ir a CollaBoard">
          <CollaBoardLogo size={40} />
          <span className="auth-brand-text">CollaBoard</span>
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
