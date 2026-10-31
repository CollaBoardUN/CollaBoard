import type { CanvasElement } from "./canvas";

/** Estado guardado de un tablero (Pizarra: GET /boards/{id}/state). */
export interface CanvasState {
  elements: CanvasElement[];
  /** Último número de secuencia persistido; nunca retrocede. */
  seq: number;
  saved_at: string | null;
}

/** Resumen que la página del tablero renderiza en el servidor. */
export interface CanvasSummary {
  elementCount: number;
  seq: number;
  savedAt: string | null;
}

export function summarizeCanvas(state: CanvasState): CanvasSummary {
  return { elementCount: state.elements.length, seq: state.seq, savedAt: state.saved_at };
}
