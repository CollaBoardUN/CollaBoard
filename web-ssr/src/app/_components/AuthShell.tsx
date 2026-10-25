import Link from "next/link";
import type { ReactNode } from "react";

import { CollaBoardLogo } from "@/ui/common/CollaBoardLogo";

interface Props {
  heading: string;
  subheading: string;
  children: ReactNode;
}

/** Marco visual de login y registro, renderizado en el servidor. */
export function AuthShell({ heading, subheading, children }: Props) {
  return (
    <main className="center-page auth-page">
      <section className="panel login-panel auth-panel" aria-labelledby="auth-heading">
        <Link href="/" className="auth-brand" aria-label="Ir a CollaBoard">
          <CollaBoardLogo size={40} />
          <span className="auth-brand-text">CollaBoard</span>
        </Link>
        <div className="auth-heading">
          <h1 id="auth-heading">{heading}</h1>
          <p className="muted">{subheading}</p>
        </div>
        {children}
      </section>
    </main>
  );
}
