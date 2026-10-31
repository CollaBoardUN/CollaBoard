"use client";

import {
  ArrowUpRight,
  Circle,
  CircleOff,
  Eraser,
  Minus,
  MousePointer2,
  PaintBucket,
  Pen,
  Pencil,
  Redo2,
  RectangleHorizontal,
  Star,
  StickyNote,
  Trash2,
  Triangle,
  Undo2,
} from "lucide-react";

import {
  STICKY_DEFAULTS,
  TRANSPARENT_FILL,
  toColorInputValue,
  type CanvasElementType,
} from "@/core/domain/canvas";
import { useBoardStore } from "@/core/stores/useBoardStore";

const tools: { id: CanvasElementType; label: string; icon: typeof Pencil }[] = [
  { id: "cursor", label: "Seleccionar (V)", icon: MousePointer2 },
  { id: "pencil", label: "Lápiz (P)", icon: Pencil },
  { id: "line", label: "Línea (L)", icon: Minus },
  { id: "rectangle", label: "Rectángulo (R)", icon: RectangleHorizontal },
  { id: "circle", label: "Círculo (C)", icon: Circle },
  { id: "triangle", label: "Triángulo", icon: Triangle },
  { id: "star", label: "Estrella", icon: Star },
  { id: "arrow", label: "Flecha (A)", icon: ArrowUpRight },
  { id: "sticky", label: "Nota adhesiva (S)", icon: StickyNote },
  { id: "eraser", label: "Borrador (E)", icon: Eraser },
];

const toolButtonClass =
  "grid h-10 w-10 shrink-0 place-items-center rounded-lg transition-colors focus-visible:outline-2 focus-visible:outline-indigo-500";

export function Toolbar() {
  const selectedTool = useBoardStore((state) => state.selectedTool);
  const setSelectedTool = useBoardStore((state) => state.setSelectedTool);
  const clearCanvas = useBoardStore((state) => state.clearCanvas);
  const undo = useBoardStore((state) => state.undo);
  const redo = useBoardStore((state) => state.redo);
  const historyStep = useBoardStore((state) => state.historyStep);
  const historyLength = useBoardStore((state) => state.history.length);
  const activeStrokeColor = useBoardStore((state) => state.activeStrokeColor);
  const activeFillColor = useBoardStore((state) => state.activeFillColor);
  const activeStrokeWidth = useBoardStore((state) => state.activeStrokeWidth);
  const setActiveStrokeColor = useBoardStore((state) => state.setActiveStrokeColor);
  const setActiveFillColor = useBoardStore((state) => state.setActiveFillColor);
  const setActiveStrokeWidth = useBoardStore((state) => state.setActiveStrokeWidth);
  const selectedElement = useBoardStore((state) =>
    state.selectedElementId ? state.elements.find((element) => element.id === state.selectedElementId) : undefined,
  );

  // With a selection the pickers edit that element; otherwise they set the defaults for new elements.
  const strokeColor = selectedElement?.strokeColor ?? activeStrokeColor;
  const fillColor = selectedElement?.fillColor ?? activeFillColor;
  const isFillTransparent = fillColor === TRANSPARENT_FILL;
  const scopeHint = selectedElement ? " (elemento seleccionado)" : " (nuevas figuras)";

  return (
    <aside
      aria-label="Herramientas del tablero"
      className="fixed left-2 top-24 z-30 flex max-h-[calc(100vh-7rem)] w-14 flex-col items-center gap-2.5 overflow-x-hidden overflow-y-auto rounded-xl border border-slate-200 bg-white p-1.5 shadow-md [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
    >
      {tools.map(({ id, label, icon: Icon }) => {
        const active = selectedTool === id;
        return (
          <button
            key={id}
            type="button"
            aria-label={label}
            aria-pressed={active}
            title={label}
            onClick={() => setSelectedTool(id)}
            className={`${toolButtonClass} ${
              active ? "bg-indigo-100 text-[#6366F1]" : "text-slate-600 hover:bg-slate-100"
            }`}
          >
            <Icon size={20} strokeWidth={1.8} />
          </button>
        );
      })}

      <div aria-hidden="true" className="h-px w-9 shrink-0 bg-slate-200" />

      {/* Selector de Borde con icono Pen y swatch indicador */}
      <label
        title={`Color de borde${scopeHint}`}
        className="relative flex h-10 w-10 shrink-0 cursor-pointer flex-col items-center justify-center gap-0.5 rounded-lg hover:bg-slate-100 transition-colors"
      >
        <input
          type="color"
          aria-label="Color de borde"
          value={toColorInputValue(strokeColor, "#1E293B")}
          onChange={(event) => setActiveStrokeColor(event.target.value)}
          className="sr-only"
        />
        <Pen size={17} className="text-slate-700" strokeWidth={1.8} />
        <span
          className="h-2.5 w-2.5 rounded-full border border-slate-300 shadow-xs"
          style={{ backgroundColor: strokeColor }}
          aria-hidden="true"
        />
      </label>

      {/* Selector de Relleno con icono PaintBucket y swatch indicador */}
      <label
        title={`Color de relleno${scopeHint}`}
        className="relative flex h-10 w-10 shrink-0 cursor-pointer flex-col items-center justify-center gap-0.5 rounded-lg hover:bg-slate-100 transition-colors"
      >
        <input
          type="color"
          aria-label="Color de relleno"
          value={toColorInputValue(fillColor, STICKY_DEFAULTS.fillColor)}
          onChange={(event) => setActiveFillColor(event.target.value)}
          className="sr-only"
        />
        <PaintBucket size={17} className="text-slate-700" strokeWidth={1.8} />
        <span
          className="h-2.5 w-2.5 rounded-full border border-slate-300 shadow-xs"
          style={{ backgroundColor: isFillTransparent ? "transparent" : fillColor }}
          aria-hidden="true"
        />
      </label>

      {/* Botón sin relleno */}
      <button
        type="button"
        aria-label="Sin relleno"
        title={isFillTransparent ? "Activar relleno" : "Sin relleno"}
        aria-pressed={isFillTransparent}
        onClick={() => setActiveFillColor(isFillTransparent ? STICKY_DEFAULTS.fillColor : TRANSPARENT_FILL)}
        className={`${toolButtonClass} ${
          isFillTransparent ? "bg-indigo-100 text-[#6366F1]" : "text-slate-500 hover:bg-slate-100"
        }`}
      >
        <CircleOff size={18} strokeWidth={1.8} />
      </button>

      {/* Grosor de trazo */}
      <div
        title={`Grosor del trazo: ${activeStrokeWidth}px`}
        className="grid h-10 w-10 shrink-0 place-items-center rounded-lg"
      >
        <input
          type="range"
          aria-label={`Grosor del trazo: ${activeStrokeWidth}px`}
          min={1}
          max={20}
          value={activeStrokeWidth}
          onChange={(event) => setActiveStrokeWidth(Number(event.target.value))}
          className="w-9 cursor-pointer accent-indigo-500"
        />
      </div>

      <div aria-hidden="true" className="h-px w-9 shrink-0 bg-slate-200" />

      {/* Deshacer */}
      <button
        type="button"
        aria-label="Deshacer"
        title="Deshacer"
        onClick={undo}
        disabled={historyStep <= 0}
        className={`${toolButtonClass} text-slate-600 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40`}
      >
        <Undo2 size={19} strokeWidth={1.8} />
      </button>

      {/* Rehacer */}
      <button
        type="button"
        aria-label="Rehacer"
        title="Rehacer"
        onClick={redo}
        disabled={historyStep >= historyLength - 1}
        className={`${toolButtonClass} text-slate-600 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40`}
      >
        <Redo2 size={19} strokeWidth={1.8} />
      </button>

      {/* Limpiar tablero */}
      <button
        type="button"
        aria-label="Limpiar tablero"
        title="Limpiar tablero"
        onClick={clearCanvas}
        className={`${toolButtonClass} text-slate-600 hover:bg-red-50 hover:text-red-600`}
      >
        <Trash2 size={19} strokeWidth={1.8} />
      </button>
    </aside>
  );
}
