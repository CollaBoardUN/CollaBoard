import "server-only";

import type { ReactNode } from "react";

import type { SessionUser } from "@/core/domain/types";
import { serverConfig } from "@/server/config";
import { WebProviders } from "./WebProviders";

/**
 * Envoltorio de toda página autenticada: entrega al cliente solo lo que necesita
 * (usuario mínimo y configuración pública), nunca el token.
 */
export function AuthedPage({ user, children }: { user: SessionUser; children: ReactNode }) {
  return (
    <WebProviders
      user={{ id: user.id, name: user.name }}
      config={{ pixelsUrl: serverConfig.pixelsUrl }}
      wsBase={serverConfig.publicWsUrl}
    >
      {children}
    </WebProviders>
  );
}
