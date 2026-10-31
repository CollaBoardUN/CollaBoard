"use client";

/**
 * Dependencias de la interfaz inyectadas por cada presentación (web o Electron):
 * transporte, APIs tipadas, usuario de la sesión y configuración pública.
 * Ningún componente de `ui/` importa Next.js ni lee credenciales.
 */
import { createContext, useContext, useMemo, type ReactNode } from "react";

import { createApis, type Apis } from "@/core/api";
import type { SessionUser } from "@/core/domain/types";
import { createApiClient } from "@/core/transport/apiClient";
import type { Transport } from "@/core/transport/types";

export interface ClientConfig {
  /** Enlace al lienzo de Pixels; `null` lo oculta. */
  pixelsUrl: string | null;
}

interface AppContextValue {
  transport: Transport;
  apis: Apis;
  user: SessionUser;
  config: ClientConfig;
}

const AppContext = createContext<AppContextValue | null>(null);

interface AppProviderProps {
  transport: Transport;
  user: SessionUser;
  config: ClientConfig;
  /** Qué hacer si una API responde 401 (web: renovar sesión; Electron: volver al login). */
  onUnauthorized: () => void;
  children: ReactNode;
}

export function AppProvider({ transport, user, config, onUnauthorized, children }: AppProviderProps) {
  const value = useMemo<AppContextValue>(
    () => ({
      transport,
      apis: createApis(createApiClient(transport, { onUnauthorized })),
      user,
      config,
    }),
    [transport, user, config, onUnauthorized],
  );
  return <AppContext value={value}>{children}</AppContext>;
}

function useApp(): AppContextValue {
  const value = useContext(AppContext);
  if (!value) throw new Error("Falta <AppProvider> por encima de este componente");
  return value;
}

export const useApis = () => useApp().apis;
export const useTransport = () => useApp().transport;
export const useSessionUser = () => useApp().user;
export const useClientConfig = () => useApp().config;
