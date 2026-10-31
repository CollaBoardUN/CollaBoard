"use client";

/**
 * Navegación desacoplada del framework. La web la implementa con `next/link` y
 * `useRouter`; Electron puede hacerlo con su propio enrutador.
 */
import { createContext, useContext, type ComponentType, type ReactNode } from "react";

export interface NavLinkProps {
  href: string;
  className?: string;
  children: ReactNode;
  title?: string;
  "aria-label"?: string;
}

export interface Navigation {
  Link: ComponentType<NavLinkProps>;
  push: (href: string) => void;
  replace: (href: string) => void;
  /** Vuelve a pedir los datos de la vista actual (en la web, re-renderiza en el servidor). */
  refresh: () => void;
}

const NavigationContext = createContext<Navigation | null>(null);

export function NavigationProvider({ value, children }: { value: Navigation; children: ReactNode }) {
  return <NavigationContext value={value}>{children}</NavigationContext>;
}

export function useNavigation(): Navigation {
  const value = useContext(NavigationContext);
  if (!value) throw new Error("Falta <NavigationProvider> por encima de este componente");
  return value;
}

export function NavLink(props: NavLinkProps) {
  const { Link } = useNavigation();
  return <Link {...props} />;
}
