/**
 * Tipos compartidos por la web SSR y el cliente local (Electron).
 *
 * Tableros, miembros e invitaciones reflejan los esquemas de Colaboración
 * (colaboracion-module/app/schemas.py). Chat y notificaciones siguen el
 * contrato de docs/p2/CONTRATOS_WEB.md mientras llegan los servicios Java y C#.
 */

export type Role = "owner" | "editor" | "viewer";
export type ShareableRole = Exclude<Role, "owner">;

/** Usuario de la sesión: lo mínimo que la interfaz necesita (nunca el token). */
export interface SessionUser {
  id: string;
  name: string;
  email?: string;
}

export interface Board {
  id: string;
  name: string;
  owner_id: string;
  my_role: Role;
  member_count: number;
  created_at: string;
  updated_at: string;
}

export interface Member {
  user_id: string;
  display_name: string | null;
  role: Role;
  joined_at: string;
}

export interface Invite {
  id: string;
  token: string;
  url: string;
  role: Role;
  created_at: string;
  expires_at: string | null;
  uses: number;
}

export interface InvitePreview {
  board_id: string;
  board_name: string;
  role: Role;
  already_member: boolean;
  current_role: Role | null;
}

export interface JoinResult {
  board_id: string;
  role: Role;
}
