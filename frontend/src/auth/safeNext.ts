/** Evita redirecciones abiertas: solo se aceptan rutas internas. */
export function safeNext(raw: string | null): string {
  if (!raw) return "/";
  return raw.startsWith("/") && !raw.startsWith("//") ? raw : "/";
}
