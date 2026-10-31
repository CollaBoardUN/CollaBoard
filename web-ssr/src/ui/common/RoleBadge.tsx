import { ROLE_LABEL } from "@/core/lib/format";
import type { Role } from "@/core/domain/types";

export function RoleBadge({ role }: { role: Role }) {
  return <span className={`role role-${role}`}>{ROLE_LABEL[role]}</span>;
}
