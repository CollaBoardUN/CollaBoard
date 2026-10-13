/**
 * components/PaletteToolbar.tsx
 * Barra de herramientas, paleta de colores y selector de modos.
 * Proporciona:
 * - Selección de modo: Dibujar, Borrar (blanco) y Mover (pan).
 * - Paleta predefinida con 16 colores clásicos de pixel art.
 * - Selector de color personalizado (input type color).
 * - Campo de texto para que el usuario defina su nombre/alias.
 * (Solo se permite colocar 1 píxel a la vez).
 */

import React from 'react';
import { Paintbrush, Eraser, Move, Palette, User, Check } from 'lucide-react';
import { ToolMode } from '../types/pixel';

interface PaletteToolbarProps {
  selectedColor: string;
  onSelectColor: (color: string) => void;
  toolMode: ToolMode;
  onChangeToolMode: (mode: ToolMode) => void;
  username: string;
  onChangeUsername: (name: string) => void;
}

// 16 colores seleccionados del Design System de CollaBoard y paletas clásicas de pixel art
const PRESET_COLORS = [
  { name: 'Negro', hex: '#000000' },
  { name: 'Gris Oscuro', hex: '#4B5563' },
  { name: 'Gris Claro', hex: '#9CA3AF' },
  { name: 'Blanco', hex: '#FFFFFF' },
  { name: 'Rojo Carmesí', hex: '#EF4444' },
  { name: 'Naranja Fuego', hex: '#F97316' },
  { name: 'Ámbar Cálido', hex: '#F59E0B' },
  { name: 'Amarillo Sol', hex: '#FBBF24' },
  { name: 'Verde Lima', hex: '#84CC16' },
  { name: 'Verde Esmeralda', hex: '#10B981' },
  { name: 'Turquesa', hex: '#06B6D4' },
  { name: 'Cian CollaBoard', hex: '#0EA5E9' },
  { name: 'Índigo CollaBoard', hex: '#6366F1' },
  { name: 'Púrpura Real', hex: '#8B5CF6' },
  { name: 'Rosa Neón', hex: '#EC4899' },
  { name: 'Café Roble', hex: '#78350F' },
];

/**
 * PaletteToolbar
 * Componente que renderiza la barra lateral de controles creativos.
 */
export const PaletteToolbar: React.FC<PaletteToolbarProps> = ({
  selectedColor,
  onSelectColor,
  toolMode,
  onChangeToolMode,
  username,
  onChangeUsername,
}) => {
  return (
    <div
      id="palette-toolbar-container"
      className="bg-white/95 backdrop-blur-md rounded-xl p-3.5 shadow-subtle border border-colla-gray200 flex flex-col gap-4"
    >
      {/* 1. Identificador del Artista */}
      <div className="flex flex-col gap-1.5">
        <label
          htmlFor="user-nickname-input"
          className="text-[11px] font-semibold text-colla-gray500 uppercase tracking-wider flex items-center gap-1.5"
        >
          <User className="w-3.5 h-3.5 text-colla-primary" /> Tu Nombre de Artista
        </label>
        <input
          id="user-nickname-input"
          type="text"
          value={username}
          maxLength={20}
          onChange={(e) => onChangeUsername(e.target.value.trim() || 'Anon')}
          className="w-full text-xs font-medium px-2.5 py-1.5 rounded-lg border border-colla-gray200 bg-slate-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-colla-primary/30 focus:border-colla-primary transition-all text-colla-gray900"
          placeholder="Escribe tu alias..."
        />
      </div>

      {/* 2. Selector de Herramienta (Dibujar / Borrar / Mover) */}
      <div className="flex flex-col gap-1.5">
        <span className="text-[11px] font-semibold text-colla-gray500 uppercase tracking-wider">
          Herramienta (1 Píxel)
        </span>
        <div className="grid grid-cols-3 gap-1.5 bg-slate-100 p-1 rounded-lg">
          <button
            id="tool-draw-btn"
            type="button"
            onClick={() => onChangeToolMode('draw')}
            className={`flex items-center justify-center gap-1.5 py-1.5 px-2 rounded-md text-xs font-semibold transition-all ${
              toolMode === 'draw'
                ? 'bg-white text-colla-primary shadow-sm border border-slate-200'
                : 'text-colla-gray500 hover:text-colla-gray900'
            }`}
          >
            <Paintbrush className="w-3.5 h-3.5" />
            Dibujar
          </button>

          <button
            id="tool-erase-btn"
            type="button"
            onClick={() => onChangeToolMode('erase')}
            className={`flex items-center justify-center gap-1.5 py-1.5 px-2 rounded-md text-xs font-semibold transition-all ${
              toolMode === 'erase'
                ? 'bg-white text-colla-primary shadow-sm border border-slate-200'
                : 'text-colla-gray500 hover:text-colla-gray900'
            }`}
          >
            <Eraser className="w-3.5 h-3.5" />
            Borrar
          </button>

          <button
            id="tool-pan-btn"
            type="button"
            onClick={() => onChangeToolMode('pan')}
            className={`flex items-center justify-center gap-1.5 py-1.5 px-2 rounded-md text-xs font-semibold transition-all ${
              toolMode === 'pan'
                ? 'bg-white text-colla-primary shadow-sm border border-slate-200'
                : 'text-colla-gray500 hover:text-colla-gray900'
            }`}
          >
            <Move className="w-3.5 h-3.5" />
            Mover
          </button>
        </div>
      </div>

      {/* 3. Paleta de Colores Predefinida */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-semibold text-colla-gray500 uppercase tracking-wider flex items-center gap-1">
            <Palette className="w-3.5 h-3.5 text-colla-secondary" /> Paleta de Colores
          </span>
          <span
            className="w-5 h-5 rounded-md border border-black/15 shadow-sm"
            style={{ backgroundColor: toolMode === 'erase' ? '#FFFFFF' : selectedColor }}
            title={`Color activo: ${toolMode === 'erase' ? '#FFFFFF' : selectedColor}`}
          />
        </div>

        <div className="grid grid-cols-4 gap-2">
          {PRESET_COLORS.map((c) => {
            const isSelected = toolMode === 'draw' && selectedColor.toLowerCase() === c.hex.toLowerCase();
            return (
              <button
                key={c.hex}
                id={`palette-color-${c.hex.replace('#', '')}`}
                type="button"
                title={`${c.name} (${c.hex})`}
                onClick={() => {
                  onSelectColor(c.hex);
                  if (toolMode === 'erase') onChangeToolMode('draw');
                }}
                className={`relative h-7 rounded-lg transition-transform hover:scale-105 border flex items-center justify-center shadow-xs ${
                  isSelected
                    ? 'ring-2 ring-colla-primary ring-offset-2 scale-105 z-10'
                    : 'border-black/10'
                }`}
                style={{ backgroundColor: c.hex }}
              >
                {isSelected && (
                  <Check
                    className={`w-3.5 h-3.5 ${
                      c.hex === '#FFFFFF' || c.hex === '#FBBF24'
                        ? 'text-black'
                        : 'text-white'
                    }`}
                  />
                )}
              </button>
            );
          })}
        </div>

        {/* 4. Selector de Color Hexadecimal Personalizado */}
        <div className="flex items-center justify-between pt-1 text-xs">
          <label htmlFor="custom-color-input" className="text-colla-gray500 text-[11px]">
            Personalizado:
          </label>
          <div className="flex items-center gap-1.5">
            <input
              id="custom-color-input"
              type="color"
              value={selectedColor}
              onChange={(e) => {
                onSelectColor(e.target.value);
                if (toolMode === 'erase') onChangeToolMode('draw');
              }}
              className="w-7 h-7 rounded cursor-pointer border border-colla-gray200 bg-transparent p-0"
            />
            <span className="font-mono text-[11px] text-colla-gray900 uppercase">
              {selectedColor}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};
