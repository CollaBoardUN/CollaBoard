/**
 * components/ActivityFeed.tsx
 * Feed en vivo de la actividad reciente en el lienzo.
 * Muestra una lista cronológica con los últimos eventos:
 * - Color colocado (muestra visual con recuadro).
 * - Nombre o alias del usuario.
 * - Coordenadas [x, y] del píxel.
 * - Tiempo relativo transcurrido (ej: "hace 3s").
 */

import React from 'react';
import { Activity, Clock } from 'lucide-react';
import { ActivityItem } from '../types/pixel';

interface ActivityFeedProps {
  activities: ActivityItem[]; // Lista de eventos recibidos por REST o WebSocket
}

/**
 * formatRelativeTime
 * Convierte una fecha ISO a un texto legible relativo ("justo ahora", "hace 4s", "hace 2m").
 * @param dateString Fecha en formato string ISO.
 * @returns Cadena con tiempo transcurrido en español.
 */
function formatRelativeTime(dateString: string): string {
  try {
    const eventTime = new Date(dateString).getTime();
    if (isNaN(eventTime)) return 'hace un momento';
    const now = Date.now();
    const diffSec = Math.max(0, Math.floor((now - eventTime) / 1000));

    if (diffSec < 5) return 'justo ahora';
    if (diffSec < 60) return `hace ${diffSec}s`;
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `hace ${diffMin}m`;
    const diffHours = Math.floor(diffMin / 60);
    return `hace ${diffHours}h`;
  } catch {
    return 'reciente';
  }
}

/**
 * ActivityFeed
 * Renderiza el contenedor con desplazamiento vertical para los eventos.
 */
export const ActivityFeed: React.FC<ActivityFeedProps> = ({ activities }) => {
  return (
    <div
      id="activity-feed-panel"
      className="bg-white/95 backdrop-blur-md rounded-xl p-3 shadow-subtle border border-colla-gray200 flex flex-col h-full"
    >
      {/* Encabezado del panel */}
      <div className="flex items-center justify-between pb-2.5 mb-2 border-b border-colla-gray200">
        <div className="flex items-center gap-2">
          <Activity className="w-4 h-4 text-colla-primary" />
          <h2 className="text-xs font-bold uppercase tracking-wider text-colla-gray900">
            Actividad Reciente
          </h2>
        </div>
        <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-indigo-50 text-colla-primary">
          En vivo
        </span>
      </div>

      {/* Lista con scroll de eventos */}
      <div className="flex-1 overflow-y-auto space-y-2 pr-1 max-h-[360px]">
        {activities.length === 0 ? (
          <div className="py-8 text-center text-colla-gray500 text-xs">
            <Clock className="w-6 h-6 mx-auto mb-1.5 opacity-40" />
            <p>Esperando actividad en el lienzo...</p>
          </div>
        ) : (
          activities.map((item) => (
            <div
              key={item.id}
              className="flex items-center justify-between p-2 rounded-lg bg-slate-50 hover:bg-slate-100/80 transition-colors border border-slate-100 text-xs"
            >
              <div className="flex items-center gap-2.5 min-w-0">
                {/* Muestra visual del color colocado */}
                <span
                  className="w-4 h-4 rounded-md shadow-sm border border-black/10 shrink-0"
                  style={{ backgroundColor: item.color }}
                  title={`Color: ${item.color}`}
                />

                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 truncate">
                    <span className="font-semibold text-colla-gray900 truncate">
                      {item.userId}
                    </span>
                    <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-white text-colla-gray500 border border-slate-200">
                      [{item.x}, {item.y}]
                    </span>
                  </div>
                </div>
              </div>

              {/* Tiempo transcurrido */}
              <span className="text-[10px] text-colla-gray500 shrink-0 font-medium ml-2">
                {formatRelativeTime(item.timestamp)}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
};
