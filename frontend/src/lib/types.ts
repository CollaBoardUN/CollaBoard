/** Tipos que reflejan exactamente los esquemas del backend (app/schemas.py). */

export type Role = "owner" | "editor" | "viewer";
export type ShareableRole = Exclude<Role, "owner">;

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
