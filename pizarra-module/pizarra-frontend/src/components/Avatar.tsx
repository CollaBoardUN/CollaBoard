import { initials } from "../lib/format";
import { inkFor } from "../lib/ink";

export function Avatar({ id, name, size = 32 }: { id: string; name: string; size?: number }) {
  return (
    <span
      className="avatar"
      style={{ width: size, height: size, borderColor: inkFor(id), color: inkFor(id) }}
      aria-hidden="true"
    >
      {initials(name)}
    </span>
  );
}
