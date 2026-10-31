"use client";

/**
 * Adaptadores de la presentación web para la capa `ui/`:
 * transporte por BFF + cookie y navegación con el enrutador de Next.js.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useMemo, useState, type ReactNode } from "react";

import type { SessionUser } from "@/core/domain/types";
import { createWebTransport } from "@/core/transport/webTransport";
import { AppProvider, type ClientConfig } from "@/ui/AppContext";
import { NavigationProvider, type Navigation, type NavLinkProps } from "@/ui/navigation";

function NextNavLink({ href, children, ...rest }: NavLinkProps) {
  return (
    <Link href={href} {...rest}>
      {children}
    </Link>
  );
}

interface WebProvidersProps {
  user: SessionUser;
  config: ClientConfig;
  /** Base `ws(s)://` configurada en el servidor; vacía = mismo origen. */
  wsBase: string;
  children: ReactNode;
}

export function WebProviders({ user, config, wsBase, children }: WebProvidersProps) {
  const router = useRouter();
  const [transport] = useState(() => createWebTransport({ wsBase }));

  const navigation = useMemo<Navigation>(
    () => ({
      Link: NextNavLink,
      push: (href) => router.push(href),
      replace: (href) => router.replace(href),
      refresh: () => router.refresh(),
    }),
    [router],
  );

  // Sesión vencida o revocada: se limpia la cookie en el servidor y se vuelve al login.
  const onUnauthorized = useCallback(() => {
    const next = window.location.pathname + window.location.search;
    // Navegación completa a propósito: es un Route Handler que borra la cookie en el servidor.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.assign(`/session/expired?next=${encodeURIComponent(next)}`);
  }, []);

  return (
    <NavigationProvider value={navigation}>
      <AppProvider transport={transport} user={user} config={config} onUnauthorized={onUnauthorized}>
        {children}
      </AppProvider>
    </NavigationProvider>
  );
}
