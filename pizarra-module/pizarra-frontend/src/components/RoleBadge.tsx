import { ROLE_LABEL } from "../lib/format";
import type { Role } from "../lib/types";

export function RoleBadge({ role }: { role: Role }) {
  return <span className={`role role-${role}`}>{ROLE_LABEL[role]}</span>;
}
