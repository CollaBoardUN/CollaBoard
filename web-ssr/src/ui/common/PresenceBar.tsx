"use client";

/**
 * Estado de la conexión en tiempo real y lista de quién está conectado.
 * Un mismo usuario con varias pestañas se muestra una sola vez.
 */
import { initials } from "@/core/lib/format";
import type { Peer } from "@/core/realtime/protocol";
import { useRealtime } from "@/core/realtime/realtimeStore";
import type { RealtimeStatus } from "@/core/realtime/RealtimeClient";
import "./presence.css";

const STATUS_LABEL: Record<RealtimeStatus, string> = {
  connecting: "Conectando…",
  online: "En línea",
  reconnecting: "Reconectando…",
  denied: "Sin acceso en vivo",
  closed: "Desconectado",
};

const MAX_VISIBLE = 5;

function uniqueUsers(peers: Peer[]): Peer[] {
  const seen = new Set<string>();
  return peers.filter((peer) => !seen.has(peer.user_id) && !!seen.add(peer.user_id));
}

export function PresenceBar() {
  const status = useRealtime((s) => s.status);
  const peers = useRealtime((s) => s.peers);
  const selfConn = useRealtime((s) => s.selfConn);

  const selfUser = peers.find((peer) => peer.conn === selfConn)?.user_id;
  const users = uniqueUsers(peers);
  const visible = users.slice(0, MAX_VISIBLE);
  const extra = users.length - visible.length;

  return (
    <div className="presence" aria-label="Personas conectadas">
      <span className={`presence-status presence-${status}`} role="status">
        <span className="presence-dot" aria-hidden="true" />
        {STATUS_LABEL[status]}
      </span>
      {status === "online" && (
        <ul className="presence-list">
          {visible.map((peer) => {
            const label = peer.user_id === selfUser ? `${peer.name} (tú)` : peer.name;
            return (
              <li
                key={peer.user_id}
                className="presence-avatar"
                style={{ background: peer.color }}
                title={label}
                aria-label={label}
              >
                {initials(peer.name)}
              </li>
            );
          })}
          {extra > 0 && (
            <li className="presence-avatar presence-more" title={`${extra} más`}>
              +{extra}
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
