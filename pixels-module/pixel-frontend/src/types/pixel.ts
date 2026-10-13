/**
 * types/pixel.ts
 * Definiciones de tipos e interfaces TypeScript para el módulo Pixels de CollaBoard.
 * Configurado para colocar estrictamente 1 píxel a la vez.
 */

// Modos de herramienta de dibujo disponibles
export type ToolMode = 'draw' | 'erase' | 'pan';

/**
 * Representa un píxel individual coloreado.
 */
export interface Pixel {
  x: number;     // Coordenada horizontal (0-199)
  y: number;     // Coordenada vertical (0-199)
  color: string; // Color en formato hexadecimal (ej: '#6366F1')
}

/**
 * Estructura de la respuesta del tablero completo al cargar la app.
 */
export interface BoardState {
  width: number;
  height: number;
  pixels: Pixel[];
}

/**
 * Evento individual en el feed de actividad reciente.
 */
export interface ActivityItem {
  id: string;
  x: number;
  y: number;
  color: string;
  userId: string;
  timestamp: string;
}

/**
 * Contadores agregados y métricas del lienzo en tiempo real.
 */
export interface Stats {
  totalPlaced: number;       // Cantidad total de píxeles colocados
  uniqueContributors: number;// Cantidad de autores distintos
  canvasWidth: number;       // Ancho (200)
  canvasHeight: number;      // Alto (200)
  usersOnline: number;       // Usuarios conectados en este momento
}

/**
 * Payload emitido por el cliente al servidor para colocar exactamente 1 píxel.
 */
export interface PlacePixelPayload {
  type: 'PLACE_PIXEL';
  x: number;
  y: number;
  color: string;
  userId: string;
}

/**
 * Mensaje emitido por el servidor cuando se actualiza un píxel en el lienzo.
 */
export interface PixelUpdatedMessage {
  type: 'PIXEL_UPDATED';
  pixels: Pixel[];
  userId: string;
  timestamp: string;
}

/**
 * Mensaje emitido por el servidor con las estadísticas en vivo actualizadas.
 */
export interface StatsUpdatedMessage {
  type: 'STATS_UPDATED';
  usersOnline: number;
  totalPlaced: number;
  uniqueContributors: number;
}

/**
 * Mensaje recibido si el cliente intentó pintar durante su tiempo de espera.
 */
export interface CooldownActiveMessage {
  type: 'COOLDOWN_ACTIVE';
  remaining: number;
  message: string;
}

/**
 * Mensaje de error general enviado por el servidor.
 */
export interface ErrorMessage {
  type: 'ERROR';
  message: string;
}

// Unión de todos los tipos de mensajes que el cliente puede recibir desde el servidor
export type ServerWebSocketMessage =
  | PixelUpdatedMessage
  | StatsUpdatedMessage
  | CooldownActiveMessage
  | ErrorMessage;
