/** Cursores de las otras personas, dibujados encima del lienzo. */
import { useRealtime } from "../realtime/realtimeStore";
import "./presence.css";

export function RemoteCursors() {
  const cursors = useRealtime((s) => s.cursors);
  const peers = useRealtime((s) => s.peers);

  return (
    <div className="remote-cursors" aria-hidden="true">
      {peers.map((peer) => {
        const cursor = cursors[peer.conn];
        if (!cursor) return null;
        return (
          <div
            key={peer.conn}
            className="remote-cursor"
            style={{ transform: `translate(${cursor.x}px, ${cursor.y}px)` }}
          >
            <svg width="18" height="18" viewBox="0 0 18 18">
              <path
                d="M1 1 L1 14 L5 10.5 L8 17 L10.5 16 L7.5 9.5 L13 9.5 Z"
                fill={peer.color}
                stroke="#fff"
                strokeWidth="1.2"
                strokeLinejoin="round"
              />
            </svg>
            <span className="remote-cursor-name" style={{ background: peer.color }}>
              {peer.name}
            </span>
          </div>
        );
      })}
    </div>
  );
}
