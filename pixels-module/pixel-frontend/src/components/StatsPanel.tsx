/**
 * components/StatsPanel.tsx
 * Panel de estadísticas en tiempo real del módulo Pixels.
 * Muestra cuatro tarjetas limpias con métricas clave:
 * 1. Usuarios en línea (con indicador pulsante verde).
 * 2. Total de píxeles pintados.
 * 3. Contribuidores o autores únicos.
 * 4. Dimensiones del tablero y estado de conexión WebSocket.
 */

import React from 'react';
import { Users, Grid, Sparkles, Layers, Wifi, WifiOff } from 'lucide-react';
import { Stats } from '../types/pixel';

interface StatsPanelProps {
  stats: Stats;            // Objeto de métricas
  isConnected: boolean;    // Estado de la conexión WebSocket
}

/**
 * StatsPanel
 * Renderiza tarjetas de métricas con estilos del Design System CollaBoard.
 */
export const StatsPanel: React.FC<StatsPanelProps> = ({ stats, isConnected }) => {
  return (
    <div id="stats-panel-container" className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
      {/* Tarjeta 1: Usuarios Online */}
      <div className="bg-white/95 backdrop-blur-md rounded-xl p-3 shadow-subtle border border-colla-gray200 flex items-center justify-between transition-all hover:border-colla-secondary/40">
        <div>
          <p className="text-[11px] font-medium text-colla-gray500 uppercase tracking-wider">
            Online
          </p>
          <div className="flex items-baseline gap-1.5 mt-0.5">
            <span className="text-xl font-bold text-colla-gray900 font-mono">
              {stats.usersOnline}
            </span>
            <span className="text-xs text-colla-gray500">usuarios</span>
          </div>
        </div>
        <div className="relative flex items-center justify-center p-2 rounded-lg bg-emerald-50 text-emerald-600">
          <Users className="w-5 h-5" />
          <span className="absolute -top-1 -right-1 flex h-2.5 w-2.5">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
            <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500"></span>
          </span>
        </div>
      </div>

      {/* Tarjeta 2: Total de Píxeles Pintados */}
      <div className="bg-white/95 backdrop-blur-md rounded-xl p-3 shadow-subtle border border-colla-gray200 flex items-center justify-between transition-all hover:border-colla-primary/40">
        <div>
          <p className="text-[11px] font-medium text-colla-gray500 uppercase tracking-wider">
            Píxeles
          </p>
          <div className="flex items-baseline gap-1.5 mt-0.5">
            <span className="text-xl font-bold text-colla-gray900 font-mono">
              {stats.totalPlaced.toLocaleString()}
            </span>
            <span className="text-xs text-colla-gray500">total</span>
          </div>
        </div>
        <div className="p-2 rounded-lg bg-indigo-50 text-colla-primary">
          <Sparkles className="w-5 h-5" />
        </div>
      </div>

      {/* Tarjeta 3: Contribuidores Únicos */}
      <div className="bg-white/95 backdrop-blur-md rounded-xl p-3 shadow-subtle border border-colla-gray200 flex items-center justify-between transition-all hover:border-colla-secondary/40">
        <div>
          <p className="text-[11px] font-medium text-colla-gray500 uppercase tracking-wider">
            Autores
          </p>
          <div className="flex items-baseline gap-1.5 mt-0.5">
            <span className="text-xl font-bold text-colla-gray900 font-mono">
              {stats.uniqueContributors}
            </span>
            <span className="text-xs text-colla-gray500">únicos</span>
          </div>
        </div>
        <div className="p-2 rounded-lg bg-sky-50 text-colla-secondary">
          <Layers className="w-5 h-5" />
        </div>
      </div>

      {/* Tarjeta 4: Dimensiones del Lienzo y Estado de Conexión */}
      <div className="bg-white/95 backdrop-blur-md rounded-xl p-3 shadow-subtle border border-colla-gray200 flex items-center justify-between transition-all hover:border-colla-gray500/40">
        <div>
          <div className="flex items-center gap-1.5">
            <p className="text-[11px] font-medium text-colla-gray500 uppercase tracking-wider">
              Lienzo
            </p>
            {isConnected ? (
              <span className="inline-flex items-center text-[10px] text-emerald-600 font-medium">
                <Wifi className="w-2.5 h-2.5 mr-0.5" /> En vivo
              </span>
            ) : (
              <span className="inline-flex items-center text-[10px] text-amber-600 font-medium animate-pulse">
                <WifiOff className="w-2.5 h-2.5 mr-0.5" /> Desconectado
              </span>
            )}
          </div>
          <div className="flex items-baseline gap-1 mt-0.5">
            <span className="text-xl font-bold text-colla-gray900 font-mono">
              {stats.canvasWidth} × {stats.canvasHeight}
            </span>
            <span className="text-xs text-colla-gray500">px</span>
          </div>
        </div>
        <div className="p-2 rounded-lg bg-slate-100 text-colla-gray500">
          <Grid className="w-5 h-5" />
        </div>
      </div>
    </div>
  );
};
