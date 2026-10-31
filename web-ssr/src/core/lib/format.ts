import type { Role } from "@/core/domain/types";

/** Zona horaria de la aplicación (Bogotá). Igual en servidor y navegador. */
export const APP_TIME_ZONE = "America/Bogota";

export const ROLE_LABEL: Record<Role, string> = {
  owner: "Dueño",
  editor: "Puede editar",
  viewer: "Solo ver",
};

export const ROLE_HINT: Record<Role, string> = {
  owner: "Administra el tablero",
  editor: "Dibuja y modifica",
  viewer: "Mira sin modificar",
};

const rtf = new Intl.RelativeTimeFormat("es", { numeric: "auto" });
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["week", 7 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
];

/** "hace 3 horas", "en 7 días", "ahora". */
export function relativeTime(iso: string, now = Date.now()): string {
  // El backend puede devolver fechas sin zona (SQLite); se interpretan como UTC.
  const hasZone = /([zZ]|[+-]\d\d:?\d\d)$/.test(iso);
  const diff = (new Date(hasZone ? iso : iso + "Z").getTime() - now) / 1000;
  for (const [unit, secs] of UNITS) {
    if (Math.abs(diff) >= secs) return rtf.format(Math.round(diff / secs), unit);
  }
  return "ahora";
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return (parts[0][0] + (parts[1]?.[0] ?? "")).toUpperCase();
}
