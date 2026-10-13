/**
 * hooks/usePixelSocket.ts
 * Hook personalizado para gestionar la conexión WebSocket con el backend.
 * Administra el ciclo de vida de la conexión, reconexión automática con retroceso
 * exponencial, y envío/recepción de eventos en tiempo real.
 * Diseñado para colocar 1 solo píxel a la vez.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import {
  Pixel,
  PlacePixelPayload,
  ServerWebSocketMessage,
  StatsUpdatedMessage,
} from '../types/pixel';

interface UsePixelSocketProps {
  onPixelUpdated?: (pixels: Pixel[], userId: string, timestamp: string) => void;
  onStatsUpdated?: (stats: StatsUpdatedMessage) => void;
  onCooldownActive?: (remaining: number, message: string) => void;
  onErrorReceived?: (message: string) => void;
}

/**
 * usePixelSocket
 * Conecta al canal /ws/pixels y expone métodos para pintar y escuchar eventos.
 */
export function usePixelSocket({
  onPixelUpdated,
  onStatsUpdated,
  onCooldownActive,
  onErrorReceived,
}: UsePixelSocketProps = {}) {
  // Estado de conexión del WebSocket (true cuando está en estado OPEN)
  const [isConnected, setIsConnected] = useState<boolean>(false);
  // Último mensaje de error recibido
  const [lastError, setLastError] = useState<string | null>(null);

  // Referencias mutables para evitar reconexiones innecesarias
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<number | null>(null);
  const reconnectAttemptsRef = useRef<number>(0);
  const isUnmountedRef = useRef<boolean>(false);

  // Mantenemos actualizadas las referencias de los callbacks pasados por props
  const onPixelUpdatedRef = useRef(onPixelUpdated);
  const onStatsUpdatedRef = useRef(onStatsUpdated);
  const onCooldownActiveRef = useRef(onCooldownActive);
  const onErrorReceivedRef = useRef(onErrorReceived);

  useEffect(() => {
    onPixelUpdatedRef.current = onPixelUpdated;
    onStatsUpdatedRef.current = onStatsUpdated;
    onCooldownActiveRef.current = onCooldownActive;
    onErrorReceivedRef.current = onErrorReceived;
  });

  /**
   * getWsUrl
   * Determina la URL adecuada del WebSocket según las variables de entorno
   * o el host actual del navegador.
   */
  const getWsUrl = useCallback(() => {
    if (import.meta.env.VITE_BACKEND_WS_URL) {
      return import.meta.env.VITE_BACKEND_WS_URL;
    }
    const host = window.location.hostname || 'localhost';
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${host}:8000/ws/pixels`;
  }, []);

  /**
   * connect
   * Abre la conexión WebSocket y asocia los manejadores de eventos.
   */
  const connect = useCallback(() => {
    if (isUnmountedRef.current) return;

    try {
      const url = getWsUrl();
      const ws = new WebSocket(url);
      wsRef.current = ws;

      // Evento: Conexión abierta con éxito
      ws.onopen = () => {
        if (isUnmountedRef.current) return;
        setIsConnected(true);
        setLastError(null);
        reconnectAttemptsRef.current = 0;
        console.log('[WebSocket] Conectado exitosamente en:', url);
      };

      // Evento: Mensaje entrante desde el servidor
      ws.onmessage = (event) => {
        if (isUnmountedRef.current) return;
        try {
          const data: ServerWebSocketMessage = JSON.parse(event.data);
          switch (data.type) {
            case 'PIXEL_UPDATED':
              onPixelUpdatedRef.current?.(data.pixels, data.userId, data.timestamp);
              break;
            case 'STATS_UPDATED':
              onStatsUpdatedRef.current?.(data);
              break;
            case 'COOLDOWN_ACTIVE':
              onCooldownActiveRef.current?.(data.remaining, data.message);
              break;
            case 'ERROR':
              setLastError(data.message);
              onErrorReceivedRef.current?.(data.message);
              break;
            default:
              break;
          }
        } catch (err) {
          console.error('[WebSocket] Error al procesar mensaje JSON:', err);
        }
      };

      // Evento: Error en la conexión
      ws.onerror = (err) => {
        console.warn('[WebSocket] Advertencia en conexión:', err);
      };

      // Evento: Conexión cerrada
      ws.onclose = () => {
        if (isUnmountedRef.current) return;
        setIsConnected(false);
        wsRef.current = null;

        // Estrategia de reconexión progresiva
        const attempt = reconnectAttemptsRef.current;
        const delay = Math.min(1000 * Math.pow(1.5, attempt), 5000);
        reconnectAttemptsRef.current += 1;

        console.log(`[WebSocket] Reconectando en ${delay}ms (intento #${attempt + 1})...`);
        reconnectTimeoutRef.current = window.setTimeout(() => {
          connect();
        }, delay);
      };
    } catch (e) {
      console.error('[WebSocket] Fallo al instanciar socket:', e);
      reconnectTimeoutRef.current = window.setTimeout(connect, 3000);
    }
  }, [getWsUrl]);

  // Iniciar la conexión al montar el hook y limpiar al desmontar
  useEffect(() => {
    isUnmountedRef.current = false;
    connect();

    return () => {
      isUnmountedRef.current = true;
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, [connect]);

  /**
   * sendPlacePixel
   * Envía la orden de colocar un único píxel al servidor.
   * @param x Coordenada X (0 a 199).
   * @param y Coordenada Y (0 a 199).
   * @param color Color en formato hexadecimal.
   * @param userId Nombre del artista.
   * @returns boolean true si el mensaje fue enviado por el socket, false si no hay conexión.
   */
  const sendPlacePixel = useCallback(
    (x: number, y: number, color: string, userId: string) => {
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
        setLastError('Sin conexión en tiempo real con el servidor.');
        return false;
      }

      const payload: PlacePixelPayload = {
        type: 'PLACE_PIXEL',
        x,
        y,
        color,
        userId,
      };

      wsRef.current.send(JSON.stringify(payload));
      return true;
    },
    []
  );

  /**
   * clearError
   * Limpia el mensaje de error activo en pantalla.
   */
  const clearError = useCallback(() => {
    setLastError(null);
  }, []);

  return {
    isConnected,
    lastError,
    sendPlacePixel,
    clearError,
  };
}
