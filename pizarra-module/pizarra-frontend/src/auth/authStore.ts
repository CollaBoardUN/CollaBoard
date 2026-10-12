/**
 * ADAPTADOR DE AUTH (frontend).
 *
 * Guarda el token JWT y los datos básicos del usuario. El módulo de login
 * de tu compañero solo tiene que llamar, después de iniciar sesión:
 *
 *     useAuth.getState().setSession(token)
 *
 * y para cerrar sesión:
 *
 *     useAuth.getState().logout()
 *
 * Todo lo demás (api.ts, rutas protegidas) lee de aquí.
 */
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

export interface SessionUser {
  id: string;
  name: string;
}

interface AuthState {
  token: string | null;
  user: SessionUser | null;
  setSession: (token: string) => void;
  logout: () => void;
}

/** Lee el contenido de un JWT SIN verificarlo (eso lo hace el backend). */
export function decodeJwt(token: string): Record<string, unknown> | null {
  try {
    const part = token.split(".")[1];
    const base64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const json = decodeURIComponent(
      atob(padded)
        .split("")
        .map((c) => "%" + c.charCodeAt(0).toString(16).padStart(2, "0"))
        .join(""),
    );
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export function userFromToken(token: string): SessionUser | null {
  const payload = decodeJwt(token);
  if (!payload || typeof payload.sub !== "string") return null;
  if (typeof payload.exp === "number" && payload.exp * 1000 < Date.now()) return null;
  const name =
    (typeof payload.name === "string" && payload.name) ||
    (typeof payload.email === "string" && payload.email) ||
    payload.sub;
  return { id: payload.sub, name };
}

export const useAuth = create<AuthState>()(
  persist(
    (set) => ({
      token: null,
      user: null,
      setSession: (token) => {
        const user = userFromToken(token);
        set(user ? { token, user } : { token: null, user: null });
      },
      logout: () => set({ token: null, user: null }),
    }),
    {
      name: "pizarra-auth",
      storage: createJSONStorage(() => localStorage),
      // Al recargar la página, descarta tokens vencidos.
      onRehydrateStorage: () => (state) => {
        if (state?.token && !userFromToken(state.token)) state.logout();
      },
    },
  ),
);
