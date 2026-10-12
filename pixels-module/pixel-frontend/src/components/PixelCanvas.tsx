/**
 * components/PixelCanvas.tsx
 * Lienzo interactivo de alto rendimiento implementado sobre HTML5 <canvas>.
 * Características:
 * - Matriz de 200x200 píxeles.
 * - Colocación de exactamente 1 píxel por acción.
 * - Soporte para Zoom (100% a 600%) con botones y rueda del ratón.
 * - Soporte para Pan (arrastre de mapa con clic derecho, botón central o modo Mover).
 * - Coordenadas flotantes [x, y] en tiempo real al pasar el cursor.
 * - Previsualización exacta de la celda de 1 píxel.
 * - Cuadrícula visible automáticamente al acercar la vista.
 * - Bloqueo visual del cursor si el cooldown está activo.
 */

import React, { useRef, useEffect, useState, useCallback } from 'react';
import { ZoomIn, ZoomOut, Maximize2, HelpCircle, Lock } from 'lucide-react';
import { Pixel, ToolMode } from '../types/pixel';

interface PixelCanvasProps {
  width: number;
  height: number;
  pixels: Pixel[];
  selectedColor: string;
  toolMode: ToolMode;
  isCoolingDown: boolean;
  onPlacePixel: (x: number, y: number, color: string) => void;
}

/**
 * PixelCanvas
 * Componente principal del lienzo interactivo.
 */
export const PixelCanvas: React.FC<PixelCanvasProps> = ({
  width = 200,
  height = 200,
  pixels,
  selectedColor,
  toolMode,
  isCoolingDown,
  onPlacePixel,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Lienzo en memoria de 200x200 para dibujar sin retrasos
  const bufferCanvasRef = useRef<HTMLCanvasElement | null>(null);

  // Estados de transformación (Zoom y Pan)
  const [zoom, setZoom] = useState<number>(2.0); // Factor de escala (2.0 = 200%)
  const [pan, setPan] = useState<{ x: number; y: number }>({ x: 0, y: 0 }); // Desplazamiento X e Y
  const [isDragging, setIsDragging] = useState<boolean>(false);
  const dragStartRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const panStartRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const hasMovedRef = useRef<boolean>(false);

  // Coordenadas bajo el cursor
  const [hoverCoord, setHoverCoord] = useState<{ x: number; y: number } | null>(null);
  const [cursorPos, setCursorPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });

  /**
   * Inicializa el buffer en memoria de 200x200 píxeles.
   */
  useEffect(() => {
    const buffer = document.createElement('canvas');
    buffer.width = width;
    buffer.height = height;
    const bCtx = buffer.getContext('2d');
    if (bCtx) {
      // Fondo inicial blanco
      bCtx.fillStyle = '#FFFFFF';
      bCtx.fillRect(0, 0, width, height);
    }
    bufferCanvasRef.current = buffer;
  }, [width, height]);

  /**
   * Actualiza el buffer en memoria cada vez que cambia la lista de píxeles pintados.
   */
  useEffect(() => {
    const buffer = bufferCanvasRef.current;
    if (!buffer) return;
    const bCtx = buffer.getContext('2d');
    if (!bCtx) return;

    // Pintar fondo base blanco
    bCtx.fillStyle = '#FFFFFF';
    bCtx.fillRect(0, 0, width, height);

    // Pintar cada píxel registrado
    for (const p of pixels) {
      if (p.x >= 0 && p.x < width && p.y >= 0 && p.y < height) {
        bCtx.fillStyle = p.color;
        bCtx.fillRect(p.x, p.y, 1, 1);
      }
    }

    renderCanvas();
  }, [pixels, width, height]);

  /**
   * renderCanvas
   * Dibuja el buffer sobre el lienzo visible aplicando escala, desplazamiento y cuadrícula.
   */
  const renderCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    const buffer = bufferCanvasRef.current;
    if (!canvas || !buffer) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Ajustar dimensiones del canvas a su contenedor
    const rect = canvas.getBoundingClientRect();
    if (canvas.width !== rect.width || canvas.height !== rect.height) {
      canvas.width = rect.width;
      canvas.height = rect.height;
    }

    // Desactivar suavizado de imagen para mantener los píxeles nítidos
    ctx.imageSmoothingEnabled = false;

    // Limpiar fondo
    ctx.fillStyle = '#E2E8F0';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.save();

    // Calcular posición centrada con el paneo actual
    const centerX = canvas.width / 2 + pan.x;
    const centerY = canvas.height / 2 + pan.y;

    const renderWidth = width * zoom;
    const renderHeight = height * zoom;

    const startX = centerX - renderWidth / 2;
    const startY = centerY - renderHeight / 2;

    // Sombra suave alrededor del tablero
    ctx.shadowColor = 'rgba(0, 0, 0, 0.12)';
    ctx.shadowBlur = 12;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 4;
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(startX, startY, renderWidth, renderHeight);

    // Reiniciar sombra
    ctx.shadowColor = 'transparent';

    // Dibujar el contenido del buffer escalado
    ctx.drawImage(
      buffer,
      0,
      0,
      width,
      height,
      startX,
      startY,
      renderWidth,
      renderHeight
    );

    // Dibujar cuadrícula tenue si el zoom es suficiente (>= 2.5x)
    if (zoom >= 2.5) {
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.06)';
      ctx.lineWidth = 0.5;

      for (let x = 0; x <= width; x++) {
        const posX = startX + x * zoom;
        ctx.beginPath();
        ctx.moveTo(posX, startY);
        ctx.lineTo(posX, startY + renderHeight);
        ctx.stroke();
      }

      for (let y = 0; y <= height; y++) {
        const posY = startY + y * zoom;
        ctx.beginPath();
        ctx.moveTo(startX, posY);
        ctx.lineTo(startX + renderWidth, posY);
        ctx.stroke();
      }
    }

    // Borde delimitador del tablero
    ctx.strokeStyle = '#94A3B8';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(startX, startY, renderWidth, renderHeight);

    // Previsualización de exactamente 1 píxel bajo el cursor
    if (hoverCoord && !isCoolingDown) {
      const { x: hx, y: hy } = hoverCoord;
      const previewColor = toolMode === 'erase' ? '#FFFFFF' : selectedColor;

      const px = startX + hx * zoom;
      const py = startY + hy * zoom;

      // Resalte semitransparente del píxel
      ctx.fillStyle = previewColor;
      ctx.globalAlpha = 0.6;
      ctx.fillRect(px, py, zoom, zoom);
      ctx.globalAlpha = 1.0;

      // Borde del píxel seleccionado
      ctx.strokeStyle = '#000000';
      ctx.lineWidth = 1;
      ctx.strokeRect(px, py, zoom, zoom);
    }

    ctx.restore();
  }, [width, height, pan, zoom, hoverCoord, isCoolingDown, toolMode, selectedColor]);

  // Redibujar ante cambios de estado
  useEffect(() => {
    renderCanvas();
  }, [renderCanvas]);

  // Escuchar redimensionamiento de ventana
  useEffect(() => {
    const handleResize = () => {
      renderCanvas();
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [renderCanvas]);

  /**
   * screenToCanvasCoords
   * Convierte coordenadas de pantalla del ratón (clientX, clientY)
   * a coordenadas de matriz del lienzo [x, y] (de 0 a 199).
   */
  const screenToCanvasCoords = useCallback(
    (clientX: number, clientY: number): { x: number; y: number } | null => {
      const canvas = canvasRef.current;
      if (!canvas) return null;
      const rect = canvas.getBoundingClientRect();
      const mouseX = clientX - rect.left;
      const mouseY = clientY - rect.top;

      const centerX = canvas.width / 2 + pan.x;
      const centerY = canvas.height / 2 + pan.y;

      const renderWidth = width * zoom;
      const renderHeight = height * zoom;

      const startX = centerX - renderWidth / 2;
      const startY = centerY - renderHeight / 2;

      const relX = mouseX - startX;
      const relY = mouseY - startY;

      const pixelX = Math.floor(relX / zoom);
      const pixelY = Math.floor(relY / zoom);

      if (pixelX >= 0 && pixelX < width && pixelY >= 0 && pixelY < height) {
        return { x: pixelX, y: pixelY };
      }
      return null;
    },
    [pan, zoom, width, height]
  );

  /**
   * handleMouseDown
   * Inicia el arrastre (pan) o registra el punto de inicio de clic.
   */
  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const isPanTrigger =
      toolMode === 'pan' ||
      e.button === 1 || // Botón central
      e.button === 2 || // Botón derecho
      e.altKey ||
      e.shiftKey;

    setIsDragging(true);
    hasMovedRef.current = false;
    dragStartRef.current = { x: e.clientX, y: e.clientY };
    panStartRef.current = { ...pan };

    if (isPanTrigger) {
      e.preventDefault();
    }
  };

  /**
   * handleMouseMove
   * Actualiza el desplazamiento del mapa si se está arrastrando
   * y calcula las coordenadas de celda bajo el cursor.
   */
  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (canvas) {
      const rect = canvas.getBoundingClientRect();
      setCursorPos({ x: e.clientX - rect.left, y: e.clientY - rect.top });
    }

    if (isDragging) {
      const dx = e.clientX - dragStartRef.current.x;
      const dy = e.clientY - dragStartRef.current.y;

      if (Math.hypot(dx, dy) > 4) {
        hasMovedRef.current = true;
      }

      setPan({
        x: panStartRef.current.x + dx,
        y: panStartRef.current.y + dy,
      });
    }

    const coords = screenToCanvasCoords(e.clientX, e.clientY);
    setHoverCoord(coords);
  };

  /**
   * handleMouseUp
   * Si no hubo desplazamiento y se usó clic izquierdo,
   * coloca exactamente 1 píxel en las coordenadas seleccionadas.
   */
  const handleMouseUp = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!hasMovedRef.current && e.button === 0 && toolMode !== 'pan') {
      if (!isCoolingDown) {
        const coords = screenToCanvasCoords(e.clientX, e.clientY);
        if (coords) {
          const colorToPlace = toolMode === 'erase' ? '#FFFFFF' : selectedColor;
          onPlacePixel(coords.x, coords.y, colorToPlace);
        }
      }
    }

    setIsDragging(false);
  };

  /**
   * handleMouseLeave
   * Finaliza el arrastre y oculta el puntero flotante si el ratón sale del canvas.
   */
  const handleMouseLeave = () => {
    setIsDragging(false);
    setHoverCoord(null);
  };

  /**
   * handleWheel
   * Permite acercar o alejar suavemente la vista con la rueda del ratón.
   */
  const handleWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const zoomDelta = e.deltaY < 0 ? 0.25 : -0.25;
    setZoom((prev) => Math.min(Math.max(0.75, Number((prev + zoomDelta).toFixed(2))), 6.0));
  };

  /**
   * Controles directos de Zoom
   */
  const handleZoomIn = () => setZoom((z) => Math.min(6.0, Number((z + 0.5).toFixed(2))));
  const handleZoomOut = () => setZoom((z) => Math.max(0.75, Number((z - 0.5).toFixed(2))));
  const handleResetView = () => {
    setZoom(2.0);
    setPan({ x: 0, y: 0 });
  };

  return (
    <div
      ref={containerRef}
      id="pixel-canvas-wrapper"
      className="relative w-full h-full flex-1 min-h-[480px] bg-slate-100 rounded-2xl overflow-hidden border border-colla-gray200 shadow-inner select-none flex flex-col"
    >
      {/* Elemento Canvas nativo */}
      <canvas
        ref={canvasRef}
        id="pixel-canvas-main"
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseLeave}
        onWheel={handleWheel}
        onContextMenu={(e) => e.preventDefault()}
        className={`w-full h-full flex-1 block touch-none ${
          isCoolingDown
            ? 'cursor-not-allowed'
            : toolMode === 'pan' || isDragging
            ? 'cursor-grab active:cursor-grabbing'
            : 'cursor-crosshair'
        }`}
      />

      {/* Tooltip flotante con coordenadas [x, y] */}
      {hoverCoord && (
        <div
          id="floating-coords-tooltip"
          className="absolute pointer-events-none z-20 px-2 py-1 rounded-md bg-colla-gray900/90 text-white text-[11px] font-mono shadow-md backdrop-blur-sm border border-white/20 flex items-center gap-1.5 transition-opacity"
          style={{
            left: Math.min(Math.max(cursorPos.x + 12, 10), (canvasRef.current?.width || 300) - 100),
            top: Math.min(Math.max(cursorPos.y + 12, 10), (canvasRef.current?.height || 300) - 40),
          }}
        >
          <span className="font-semibold text-colla-secondary">
            [{hoverCoord.x}, {hoverCoord.y}]
          </span>
          {isCoolingDown && (
            <span className="text-amber-300 flex items-center gap-0.5">
              <Lock className="w-2.5 h-2.5" /> espera
            </span>
          )}
        </div>
      )}

      {/* Barra de herramientas flotante de navegación y zoom */}
      <div
        id="canvas-zoom-toolbar"
        className="absolute bottom-4 left-4 z-10 flex items-center gap-1 bg-white/90 backdrop-blur-md p-1.5 rounded-xl shadow-subtle border border-colla-gray200"
      >
        <button
          type="button"
          onClick={handleZoomOut}
          title="Alejar (-)"
          className="p-1.5 rounded-lg text-colla-gray500 hover:text-colla-gray900 hover:bg-slate-100 transition-colors"
        >
          <ZoomOut className="w-4 h-4" />
        </button>

        {/* Niveles de zoom predefinidos (100%, 200%, 300%) */}
        {[1.0, 2.0, 3.0].map((level) => (
          <button
            key={level}
            type="button"
            onClick={() => setZoom(level)}
            className={`px-2 py-1 rounded-md text-xs font-mono font-medium transition-colors ${
              Math.abs(zoom - level) < 0.2
                ? 'bg-colla-primary text-white shadow-xs font-bold'
                : 'text-colla-gray500 hover:text-colla-gray900 hover:bg-slate-100'
            }`}
          >
            {Math.round(level * 100)}%
          </button>
        ))}

        <button
          type="button"
          onClick={handleZoomIn}
          title="Acercar (+)"
          className="p-1.5 rounded-lg text-colla-gray500 hover:text-colla-gray900 hover:bg-slate-100 transition-colors"
        >
          <ZoomIn className="w-4 h-4" />
        </button>

        <div className="w-[1px] h-4 bg-colla-gray200 mx-0.5" />

        <button
          type="button"
          onClick={handleResetView}
          title="Centrar lienzo"
          className="p-1.5 rounded-lg text-colla-gray500 hover:text-colla-gray900 hover:bg-slate-100 transition-colors flex items-center gap-1 text-xs"
        >
          <Maximize2 className="w-3.5 h-3.5" />
          <span className="hidden sm:inline">Centrar</span>
        </button>
      </div>

      {/* Guía rápida de atajos de navegación */}
      <div className="absolute top-4 left-4 z-10 pointer-events-none hidden sm:flex items-center gap-1.5 bg-white/80 backdrop-blur-sm px-2.5 py-1 rounded-lg text-[11px] text-colla-gray500 border border-slate-200 shadow-xs">
        <HelpCircle className="w-3.5 h-3.5 text-colla-primary" />
        <span>Rueda: Zoom · Arrastrar: Mover · Clic: Pintar 1 Píxel</span>
      </div>
    </div>
  );
};
