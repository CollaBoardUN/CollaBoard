/**
 * hooks/useCooldown.ts
 * Hook personalizado para manejar el tiempo de espera (cooldown) del usuario.
 * Controla la cuenta regresiva fluida y sincroniza con el servidor si este
 * impone un tiempo restante específico.
 */

import { useState, useEffect, useRef, useCallback } from 'react';

/**
 * useCooldown
 * @param defaultDuration Duración estándar del cooldown en segundos (5.0s por defecto).
 * @returns Estado de cooldown, tiempo restante, porcentaje para la barra y funciones de control.
 */
export function useCooldown(defaultDuration: number = 5.0) {
  // Tiempo restante en segundos (ej: 4.8)
  const [remainingTime, setRemainingTime] = useState<number>(0);
  // Duración total de la cuenta regresiva actual
  const [totalDuration, setTotalDuration] = useState<number>(defaultDuration);
  // Referencia al ID del temporizador para limpiarlo adecuadamente
  const timerRef = useRef<number | null>(null);

  /**
   * startCooldown
   * Inicia localmente una cuenta regresiva de cooldown (ej: inmediatamente tras hacer clic).
   * @param duration Duración en segundos (por defecto la predeterminada de 5.0s).
   */
  const startCooldown = useCallback((duration: number = defaultDuration) => {
    setTotalDuration(duration);
    setRemainingTime(duration);

    if (timerRef.current) {
      clearInterval(timerRef.current);
    }

    const intervalStepMs = 50; // Intervalo de 50ms para una animación suave
    const stepSeconds = intervalStepMs / 1000;

    timerRef.current = window.setInterval(() => {
      setRemainingTime((prev) => {
        const next = prev - stepSeconds;
        if (next <= 0) {
          if (timerRef.current) clearInterval(timerRef.current);
          return 0;
        }
        return next;
      });
    }, intervalStepMs);
  }, [defaultDuration]);

  /**
   * setServerCooldown
   * Sincroniza el temporizador si el servidor responde con un tiempo restante exacto.
   * @param seconds Segundos restantes dictados por el servidor.
   */
  const setServerCooldown = useCallback((seconds: number) => {
    if (seconds <= 0) {
      setRemainingTime(0);
      if (timerRef.current) clearInterval(timerRef.current);
      return;
    }

    setTotalDuration((prev) => Math.max(prev, seconds));
    setRemainingTime(seconds);

    if (timerRef.current) {
      clearInterval(timerRef.current);
    }

    const intervalStepMs = 50;
    const stepSeconds = intervalStepMs / 1000;

    timerRef.current = window.setInterval(() => {
      setRemainingTime((prev) => {
        const next = prev - stepSeconds;
        if (next <= 0) {
          if (timerRef.current) clearInterval(timerRef.current);
          return 0;
        }
        return next;
      });
    }, intervalStepMs);
  }, []);

  // Limpieza del temporizador al desmontar el componente
  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
    };
  }, []);

  // Indica si el usuario está actualmente bloqueado por el temporizador
  const isCoolingDown = remainingTime > 0;

  // Porcentaje restante (0 a 100) para pintar la barra de progreso
  const progressPercent = totalDuration > 0
    ? Math.max(0, Math.min(100, (remainingTime / totalDuration) * 100))
    : 0;

  return {
    isCoolingDown,
    remainingTime: Math.max(0, remainingTime),
    totalDuration,
    progressPercent,
    startCooldown,
    setServerCooldown,
  };
}
