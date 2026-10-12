/**
 * components/CooldownTimer.tsx
 * Barra visual de tiempo de espera (cooldown anti-spam).
 * Proporciona retroalimentación visual clara con cuenta regresiva en segundos,
 * cambio de colores (ámbar a verde) y estado de bloqueo.
 */

import React from 'react';
import { CheckCircle2, Lock } from 'lucide-react';

interface CooldownTimerProps {
  remainingTime: number;   // Segundos restantes (ej: 3.2)
  totalDuration: number;   // Duración de la cuenta regresiva (ej: 5.0)
  isCoolingDown: boolean;  // Si es true, el canvas está bloqueado temporalmente
  progressPercent: number; // Valor de 0 a 100 para la barra de progreso
}

/**
 * CooldownTimer
 * Componente que muestra la barra de progreso animada y el tiempo restante.
 */
export const CooldownTimer: React.FC<CooldownTimerProps> = ({
  remainingTime,
  totalDuration,
  isCoolingDown,
  progressPercent,
}) => {
  return (
    <div
      id="cooldown-timer-panel"
      className="bg-white/95 backdrop-blur-md rounded-xl p-3 shadow-subtle border border-colla-gray200 transition-all duration-200"
    >
      {/* Encabezado del estado: Icono y texto */}
      <div className="flex items-center justify-between mb-2 text-xs">
        <div className="flex items-center gap-1.5 font-medium">
          {isCoolingDown ? (
            <>
              <Lock className="w-3.5 h-3.5 text-colla-warning animate-pulse" />
              <span className="text-colla-gray900 font-semibold">Tiempo de espera</span>
            </>
          ) : (
            <>
              <CheckCircle2 className="w-3.5 h-3.5 text-colla-success" />
              <span className="text-colla-gray900 font-semibold">Listo para pintar</span>
            </>
          )}
        </div>

        {/* Contador numérico de segundos */}
        <div className="font-mono text-xs font-semibold">
          {isCoolingDown ? (
            <span className="text-colla-warning">{remainingTime.toFixed(1)}s</span>
          ) : (
            <span className="text-colla-success font-medium">0.0s</span>
          )}
        </div>
      </div>

      {/* Contenedor de la barra de progreso */}
      <div className="w-full bg-slate-100 rounded-full h-2.5 overflow-hidden border border-slate-200/60">
        <div
          id="cooldown-progress-bar"
          className={`h-full transition-all duration-75 ease-out rounded-full ${
            isCoolingDown
              ? 'bg-gradient-to-r from-amber-400 to-amber-500'
              : 'bg-emerald-500'
          }`}
          style={{
            width: isCoolingDown ? `${progressPercent}%` : '100%',
          }}
        />
      </div>

      {/* Pie informativo */}
      <div className="mt-1.5 flex justify-between items-center text-[10px] text-colla-gray500">
        <span>{isCoolingDown ? 'Lienzo bloqueado anti-spam' : 'Haz clic en el lienzo para pintar'}</span>
        <span>{totalDuration.toFixed(0)}s cooldown</span>
      </div>
    </div>
  );
};
