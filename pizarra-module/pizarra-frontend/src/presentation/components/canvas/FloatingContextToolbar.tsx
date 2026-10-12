import { CircleOff, PaintBucket, Pen, Trash2, Type } from "lucide-react";
import { Html } from "react-konva-utils";

import {
  DEFAULT_FONT_FAMILY,
  DEFAULT_TEXT_COLOR,
  FONT_FAMILY_OPTIONS,
  STICKY_DEFAULTS,
  TRANSPARENT_FILL,
  toColorInputValue,
  type CanvasElement,
} from "../../../domain/models/canvas";

interface FloatingContextToolbarProps {
  element: CanvasElement;
  bounds: { x: number; y: number; width: number; height: number };
  onStrokeColorChange: (color: string) => void;
  onFillColorChange: (color: string) => void;
  onStrokeWidthChange: (width: number) => void;
  onTextColorChange: (color: string) => void;
  onFontFamilyChange: (font: string) => void;
  onDelete: (id: string) => void;
}

export function FloatingContextToolbar({
  element,
  bounds,
  onStrokeColorChange,
  onFillColorChange,
  onStrokeWidthChange,
  onTextColorChange,
  onFontFamilyChange,
  onDelete,
}: FloatingContextToolbarProps) {
  const isFillTransparent = element.fillColor === TRANSPARENT_FILL;
  const isNearTop = bounds.y < 65;
  const menuX = bounds.x + bounds.width / 2;
  const menuY = isNearTop ? bounds.y + bounds.height + 12 : bounds.y - 12;

  const currentTextColor = element.textColor ?? DEFAULT_TEXT_COLOR;
  const currentFontFamily = element.fontFamily ?? DEFAULT_FONT_FAMILY;

  return (
    <Html groupProps={{ x: menuX, y: menuY }}>
      <div
        role="toolbar"
        aria-label="Barra de herramientas del elemento seleccionado"
        className="flex items-center gap-2 rounded-xl border border-slate-200/90 bg-white/95 px-3 py-1.5 shadow-2xl backdrop-blur-md"
        style={{
          position: "absolute",
          transform: isNearTop ? "translate(-50%, 0)" : "translate(-50%, -100%)",
          pointerEvents: "auto",
          userSelect: "none",
          whiteSpace: "nowrap",
          zIndex: 50,
        }}
        onMouseDown={(event) => event.stopPropagation()}
        onTouchStart={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
      >
        {/* Selector de Relleno */}
        <label
          title="Color de relleno"
          className="relative flex h-9 w-9 cursor-pointer flex-col items-center justify-center gap-0.5 rounded-lg hover:bg-slate-100 transition-colors"
        >
          <input
            type="color"
            aria-label="Color de relleno"
            value={toColorInputValue(element.fillColor, STICKY_DEFAULTS.fillColor)}
            onChange={(event) => onFillColorChange(event.target.value)}
            className="sr-only"
          />
          <PaintBucket size={15} className="text-slate-700" strokeWidth={1.8} />
          <span
            className="h-2 w-2 rounded-full border border-slate-300 shadow-xs"
            style={{ backgroundColor: isFillTransparent ? "transparent" : element.fillColor }}
            aria-hidden="true"
          />
        </label>

        {/* Botón sin relleno */}
        <button
          type="button"
          aria-label="Sin relleno"
          title={isFillTransparent ? "Activar relleno" : "Sin relleno"}
          aria-pressed={isFillTransparent}
          onClick={() =>
            onFillColorChange(isFillTransparent ? STICKY_DEFAULTS.fillColor : TRANSPARENT_FILL)
          }
          className={`grid h-7 w-7 place-items-center rounded-md transition-colors ${
            isFillTransparent
              ? "bg-indigo-100 text-[#6366F1]"
              : "text-slate-500 hover:bg-slate-100"
          }`}
        >
          <CircleOff size={14} strokeWidth={2} />
        </button>

        <div aria-hidden="true" className="h-5 w-px bg-slate-200" />

        {/* Selector de Borde */}
        <label
          title="Color de borde"
          className="relative flex h-9 w-9 cursor-pointer flex-col items-center justify-center gap-0.5 rounded-lg hover:bg-slate-100 transition-colors"
        >
          <input
            type="color"
            aria-label="Color de borde"
            value={toColorInputValue(element.strokeColor, "#1E293B")}
            onChange={(event) => onStrokeColorChange(event.target.value)}
            className="sr-only"
          />
          <Pen size={15} className="text-slate-700" strokeWidth={1.8} />
          <span
            className="h-2 w-2 rounded-full border border-slate-300 shadow-xs"
            style={{ backgroundColor: element.strokeColor }}
            aria-hidden="true"
          />
        </label>

        <div aria-hidden="true" className="h-5 w-px bg-slate-200" />

        {/* Grosor de borde */}
        <div
          title={`Grosor de trazo: ${element.strokeWidth}px`}
          className="flex items-center gap-1.5 px-1"
        >
          <span className="w-5 text-right text-[11px] font-semibold text-slate-500">
            {element.strokeWidth}px
          </span>
          <input
            type="range"
            aria-label="Grosor de trazo"
            min={1}
            max={20}
            value={element.strokeWidth}
            onChange={(event) => onStrokeWidthChange(Number(event.target.value))}
            className="h-1.5 w-14 cursor-pointer accent-indigo-500"
          />
        </div>

        <div aria-hidden="true" className="h-5 w-px bg-slate-200" />

        {/* Selector de Color de Texto */}
        <label
          title="Color del texto"
          className="relative flex h-9 w-9 cursor-pointer flex-col items-center justify-center gap-0.5 rounded-lg hover:bg-slate-100 transition-colors"
        >
          <input
            type="color"
            aria-label="Color del texto"
            value={toColorInputValue(currentTextColor, DEFAULT_TEXT_COLOR)}
            onChange={(event) => onTextColorChange(event.target.value)}
            className="sr-only"
          />
          <Type size={16} className="text-slate-700" strokeWidth={2} />
          <span
            className="h-2 w-2 rounded-full border border-slate-300 shadow-xs"
            style={{ backgroundColor: currentTextColor }}
            aria-hidden="true"
          />
        </label>

        {/* Selector de Tipografía */}
        <select
          aria-label="Tipografía"
          title="Tipografía del texto"
          value={currentFontFamily}
          onChange={(event) => onFontFamilyChange(event.target.value)}
          className="h-7 cursor-pointer rounded-md border border-slate-200 bg-white px-2 text-xs font-medium text-slate-700 shadow-xs outline-none hover:bg-slate-50 focus:border-indigo-400"
        >
          {FONT_FAMILY_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>

        <div aria-hidden="true" className="h-5 w-px bg-slate-200" />

        {/* Eliminar elemento */}
        <button
          type="button"
          aria-label="Eliminar figura"
          title="Eliminar figura"
          onClick={() => onDelete(element.id)}
          className="grid h-8 w-8 place-items-center rounded-lg text-slate-500 transition-colors hover:bg-red-50 hover:text-red-600"
        >
          <Trash2 size={16} strokeWidth={2} />
        </button>
      </div>
    </Html>
  );
}
