/**
 * App.tsx
 * Componente raíz del cliente web Pixels (CollaBoard).
 * Orquesta y coordina:
 * - Carga inicial de datos mediante HTTP REST (/api/pixels/board, stats, activity).
 * - Conexión continua bidireccional por WebSocket (/ws/pixels).
 * - Sincronización del estado del lienzo, contadores y feed en vivo.
 * - Manejo de temporizador de espera (Cooldown) para prevenir spam.
 * - Interfaz gráfica con lienzo HTML5 y barra de herramientas.
 * - Restringido a colocar estrictamente 1 píxel por acción.
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Layers, AlertCircle, X, SquarePen, ExternalLink } from 'lucide-react';
import { Pixel, ActivityItem, Stats, ToolMode } from './types/pixel';
import { useCooldown } from './hooks/useCooldown';
import { usePixelSocket } from './hooks/usePixelSocket';
import { PixelCanvas } from './components/PixelCanvas';
import { PaletteToolbar } from './components/PaletteToolbar';
import { CooldownTimer } from './components/CooldownTimer';
import { StatsPanel } from './components/StatsPanel';
import { ActivityFeed } from './components/ActivityFeed';
import { CollaBoardLogo } from './components/CollaBoardLogo';

// Resuelve la URL base HTTP para el backend
const BACKEND_HTTP_URL =
  import.meta.env.VITE_BACKEND_HTTP_URL ||
  (typeof window !== 'undefined'
    ? `${window.location.protocol}//${window.location.hostname || 'localhost'}:8000`
    : 'http://localhost:8000');

// URL hacia el módulo de la Pizarra colaborativa
const PIZARRA_URL =
  import.meta.env.VITE_PIZARRA_URL ||
  (typeof window !== 'undefined'
    ? `${window.location.protocol}//${window.location.hostname || 'localhost'}:5173`
    : 'http://localhost:5173');

export const App: React.FC = () => {
  // 1. Identidad del usuario (guardada en localStorage para persistir entre recargas)
  const [username, setUsername] = useState<string>(() => {
    return (
      localStorage.getItem('collaboard_pixel_user') ||
      `Artista#${Math.floor(1000 + Math.random() * 9000)}`
    );
  });

  /**
   * handleUpdateUsername
   * Actualiza el alias del usuario en el estado y en localStorage.
   */
  const handleUpdateUsername = (name: string) => {
    setUsername(name);
    localStorage.setItem('collaboard_pixel_user', name);
  };

  // 2. Herramientas de dibujo activas
  const [selectedColor, setSelectedColor] = useState<string>('#6366F1');
  const [toolMode, setToolMode] = useState<ToolMode>('draw');

  // 3. Estados de datos del lienzo
  const [pixelsMap, setPixelsMap] = useState<Map<string, Pixel>>(new Map());
  const [stats, setStats] = useState<Stats>({
    totalPlaced: 0,
    uniqueContributors: 0,
    canvasWidth: 200,
    canvasHeight: 200,
    usersOnline: 1,
  });
  const [activities, setActivities] = useState<ActivityItem[]>([]);
  const [bannerError, setBannerError] = useState<string | null>(null);

  // 4. Hook de cooldown (5.0 segundos por defecto)
  const cooldown = useCooldown(5.0);

  /**
   * handlePixelUpdated
   * Invocado cuando llega un evento WebSocket 'PIXEL_UPDATED'.
   * Añade el nuevo píxel al mapa del lienzo y agrega la entrada al feed.
   */
  const handlePixelUpdated = useCallback(
    (newPixels: Pixel[], author: string, timestamp: string) => {
      setPixelsMap((prev) => {
        const nextMap = new Map(prev);
        for (const p of newPixels) {
          nextMap.set(`${p.x}_${p.y}`, p);
        }
        return nextMap;
      });

      if (newPixels.length > 0) {
        const refP = newPixels[0];
        const newActivity: ActivityItem = {
          id: `${Date.now()}_${Math.random()}`,
          x: refP.x,
          y: refP.y,
          color: refP.color,
          userId: author,
          timestamp,
        };

        setActivities((prev) => [newActivity, ...prev.slice(0, 14)]);
      }
    },
    []
  );

  /**
   * handleStatsUpdated
   * Invocado cuando llega un evento WebSocket 'STATS_UPDATED'.
   * Refresca las métricas numéricas del panel superior.
   */
  const handleStatsUpdated = useCallback((data: { usersOnline: number; totalPlaced: number; uniqueContributors: number }) => {
    setStats((prev) => ({
      ...prev,
      usersOnline: data.usersOnline,
      totalPlaced: data.totalPlaced,
      uniqueContributors: data.uniqueContributors,
    }));
  }, []);

  /**
   * handleCooldownActive
   * Invocado si el servidor rechaza una colocación por tiempo de espera pendiente.
   */
  const handleCooldownActive = useCallback(
    (remaining: number, message: string) => {
      cooldown.setServerCooldown(remaining);
      setBannerError(message);
    },
    [cooldown]
  );

  /**
   * handleErrorReceived
   * Invocado cuando se recibe un error del WebSocket.
   */
  const handleErrorReceived = useCallback((msg: string) => {
    setBannerError(msg);
  }, []);

  // 5. Instancia del hook de WebSocket
  const { isConnected, sendPlacePixel } = usePixelSocket({
    onPixelUpdated: handlePixelUpdated,
    onStatsUpdated: handleStatsUpdated,
    onCooldownActive: handleCooldownActive,
    onErrorReceived: handleErrorReceived,
  });

  /**
   * Carga inicial de datos mediante la API REST (Board, Stats y Activity).
   */
  useEffect(() => {
    const fetchInitialData = async () => {
      try {
        // Cargar estado inicial del lienzo
        const boardRes = await fetch(`${BACKEND_HTTP_URL}/api/pixels/board`);
        if (boardRes.ok) {
          const boardData = await boardRes.json();
          const initialMap = new Map<string, Pixel>();
          if (Array.isArray(boardData.pixels)) {
            for (const p of boardData.pixels) {
              initialMap.set(`${p.x}_${p.y}`, p);
            }
          }
          setPixelsMap(initialMap);
        }

        // Cargar estadísticas
        const statsRes = await fetch(`${BACKEND_HTTP_URL}/api/pixels/stats`);
        if (statsRes.ok) {
          const statsData = await statsRes.json();
          setStats(statsData);
        }

        // Cargar actividad reciente
        const actRes = await fetch(`${BACKEND_HTTP_URL}/api/pixels/activity`);
        if (actRes.ok) {
          const actData = await actRes.json();
          if (Array.isArray(actData)) {
            setActivities(actData);
          }
        }
      } catch (err) {
        console.warn('Aviso de carga inicial (el servidor backend podría estar iniciando):', err);
      }
    };

    fetchInitialData();
  }, []);

  // Conversión eficiente de Map a Array para el renderizado del Canvas
  const pixelsArray = useMemo(() => {
    return Array.from(pixelsMap.values());
  }, [pixelsMap]);

  /**
   * handlePlacePixel
   * Se ejecuta cuando el usuario hace clic sobre una celda del lienzo.
   * Coloca exactamente 1 píxel.
   * Valida cooldown localmente, emite mensaje al WebSocket e inicia el temporizador.
   */
  const handlePlacePixel = (x: number, y: number, color: string) => {
    if (cooldown.isCoolingDown) {
      return;
    }

    const sent = sendPlacePixel(x, y, color, username);
    if (sent) {
      cooldown.startCooldown(5.0);
    }
  };

  return (
    <div className="flex flex-col h-screen w-screen bg-colla-bg text-colla-gray900 overflow-hidden font-sans">
      {/* Barra superior institucional */}
      <header className="h-14 bg-white/95 backdrop-blur-md border-b border-colla-gray200 px-4 md:px-6 flex items-center justify-between shrink-0 shadow-subtle z-30">
        <div className="flex items-center gap-3">
          <CollaBoardLogo size={32} />
          <div className="flex items-center gap-2">
            <h1 className="text-base font-bold text-colla-gray900 tracking-tight">
              CollaBoard
            </h1>
            <span className="text-[11px] font-semibold uppercase px-2 py-0.5 rounded-full bg-indigo-50 text-colla-primary border border-indigo-100/80">
              Pixels Wplace
            </span>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div className="hidden sm:flex items-center gap-2 text-xs text-colla-gray500">
            <span className="w-2 h-2 rounded-full bg-colla-success animate-pulse" />
            <span className="font-medium">1 Píxel por Turno · Tablero 200×200</span>
          </div>

          {/* Botón para navegar a la Pizarra */}
          <a
            href={PIZARRA_URL}
            id="nav-to-pizarra-btn"
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-indigo-50 hover:bg-indigo-100 text-colla-primary border border-indigo-200 transition-colors shadow-xs"
            title="Ir a la Pizarra Colaborativa"
          >
            <SquarePen className="w-3.5 h-3.5" />
            <span>Ir a Pizarra</span>
            <ExternalLink className="w-3 h-3 opacity-60 ml-0.5" />
          </a>
        </div>
      </header>

      {/* Banner de alerta o notificación */}
      {bannerError && (
        <div className="bg-amber-500 text-white px-4 py-2 text-xs flex items-center justify-between shadow-md shrink-0 transition-all">
          <div className="flex items-center gap-2 font-medium">
            <AlertCircle className="w-4 h-4" />
            <span>{bannerError}</span>
          </div>
          <button
            type="button"
            onClick={() => setBannerError(null)}
            className="p-1 hover:bg-amber-600 rounded transition-colors"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Espacio de trabajo principal */}
      <main className="flex-1 flex flex-col lg:flex-row p-3 md:p-4 gap-3 md:gap-4 overflow-hidden min-h-0">
        {/* Zona izquierda: Métricas en vivo y Lienzo interactivo */}
        <section className="flex-1 flex flex-col gap-3 min-w-0 min-h-0">
          <StatsPanel stats={stats} isConnected={isConnected} />

          <div className="flex-1 relative min-h-0">
            <PixelCanvas
              width={stats.canvasWidth || 200}
              height={stats.canvasHeight || 200}
              pixels={pixelsArray}
              selectedColor={selectedColor}
              toolMode={toolMode}
              isCoolingDown={cooldown.isCoolingDown}
              onPlacePixel={handlePlacePixel}
            />
          </div>
        </section>

        {/* Zona derecha: Temporizador, paleta de herramientas y feed */}
        <aside className="w-full lg:w-80 flex flex-col gap-3 shrink-0 overflow-y-auto max-h-full">
          <CooldownTimer
            remainingTime={cooldown.remainingTime}
            totalDuration={cooldown.totalDuration}
            isCoolingDown={cooldown.isCoolingDown}
            progressPercent={cooldown.progressPercent}
          />

          <PaletteToolbar
            selectedColor={selectedColor}
            onSelectColor={setSelectedColor}
            toolMode={toolMode}
            onChangeToolMode={setToolMode}
            username={username}
            onChangeUsername={handleUpdateUsername}
          />

          <div className="flex-1 min-h-[220px]">
            <ActivityFeed activities={activities} />
          </div>
        </aside>
      </main>
    </div>
  );
};

export default App;
