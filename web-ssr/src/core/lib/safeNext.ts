/** Evita redirecciones abiertas: solo se aceptan rutas internas de la aplicación. */
export function safeNext(raw: string | null | undefined): string {
  if (!raw) return "/";
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return "/";
  // Las rutas técnicas no son destinos válidos después de iniciar sesión.
  if (/^\/(bff|session|_next|api|ws)(\/|$|\?)/.test(raw)) return "/";
  return raw;
}
