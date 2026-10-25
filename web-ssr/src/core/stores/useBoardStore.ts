import { create } from "zustand";

import {
  DEFAULT_FONT_FAMILY,
  DEFAULT_TEXT_COLOR,
  type CanvasElement,
  type CanvasElementGeometry,
  type CanvasElementStyle,
  type CanvasElementType,
} from "@/core/domain/canvas";

interface BoardState {
  elements: CanvasElement[];
  selectedTool: CanvasElementType;
  selectedElementId: string | null;
  activeStrokeColor: string;
  activeFillColor: string;
  activeStrokeWidth: number;
  activeTextColor: string;
  activeFontFamily: string;
  history: CanvasElement[][];
  historyStep: number;
  /**
   * Identifies the last committed edit so consecutive edits of the same kind
   * (e.g. dragging a color picker over a selected element) collapse into a
   * single undo step instead of flooding the history.
   */
  historyMergeKey: string | null;
  setSelectedTool: (tool: CanvasElementType) => void;
  setSelectedElementId: (id: string | null) => void;
  /** Updates the selected element's stroke, or the default for new elements when nothing is selected. */
  setActiveStrokeColor: (color: string) => void;
  /** Updates the selected element's fill, or the default for new elements when nothing is selected. */
  setActiveFillColor: (color: string) => void;
  /** Updates the selected element's stroke width, or the default for new elements when nothing is selected. */
  setActiveStrokeWidth: (width: number) => void;
  /** Updates the selected element's text color, or the default for new elements when nothing is selected. */
  setActiveTextColor: (color: string) => void;
  /** Updates the selected element's font family, or the default for new elements when nothing is selected. */
  setActiveFontFamily: (font: string) => void;
  addElement: (element: CanvasElement) => void;
  updateElementText: (id: string, text: string) => void;
  updateElementPosition: (id: string, x: number, y: number) => void;
  /** Persists the result of a resize/transform as a single undo step. */
  updateElementGeometry: (id: string, geometry: CanvasElementGeometry) => void;
  deleteElement: (id: string) => void;
  clearCanvas: () => void;
  undo: () => void;
  redo: () => void;
}

type HistorySlice = Pick<BoardState, "history" | "historyStep" | "historyMergeKey">;

/** Pushes a new snapshot, or replaces the latest one when the edit continues the previous one. */
const commit = (
  state: HistorySlice,
  elements: CanvasElement[],
  mergeKey: string | null = null,
): HistorySlice => {
  const merge = mergeKey !== null && state.historyMergeKey === mergeKey && state.historyStep > 0;
  const base = state.history.slice(0, merge ? state.historyStep : state.historyStep + 1);
  const history = [...base, elements];
  return { history, historyStep: history.length - 1, historyMergeKey: mergeKey };
};

/** Returns a new array with the patched element, or `null` when nothing actually changed. */
const patchElement = (
  elements: CanvasElement[],
  id: string,
  patch: Partial<CanvasElement>,
): CanvasElement[] | null => {
  let changed = false;
  const next = elements.map((element) => {
    if (element.id !== id) return element;
    const isSame = (Object.keys(patch) as (keyof CanvasElement)[]).every((key) => element[key] === patch[key]);
    if (isSame) return element;
    changed = true;
    return { ...element, ...patch };
  });
  return changed ? next : null;
};

/** Applies a style change to the selected element (with history) or to the tool defaults. */
const applyStyle = <K extends keyof CanvasElementStyle>(
  state: BoardState,
  key: K,
  value: CanvasElementStyle[K],
  activeKey:
    | "activeStrokeColor"
    | "activeFillColor"
    | "activeStrokeWidth"
    | "activeTextColor"
    | "activeFontFamily",
): Partial<BoardState> => {
  const { selectedElementId } = state;
  if (!selectedElementId) return { [activeKey]: value };
  const elements = patchElement(state.elements, selectedElementId, { [key]: value });
  if (!elements) return {};
  return {
    elements,
    ...commit(state, elements, `style:${key}:${selectedElementId}`),
  };
};

export const useBoardStore = create<BoardState>((set) => ({
  elements: [],
  selectedTool: "pencil",
  selectedElementId: null,
  activeStrokeColor: "#1E293B",
  activeFillColor: "#FEF08A",
  activeStrokeWidth: 3,
  activeTextColor: DEFAULT_TEXT_COLOR,
  activeFontFamily: DEFAULT_FONT_FAMILY,
  history: [[]],
  historyStep: 0,
  historyMergeKey: null,
  setSelectedTool: (selectedTool) =>
    set((state) => ({
      selectedTool,
      // Selection only exists in cursor mode; drawing tools must never restyle a hidden selection.
      selectedElementId: selectedTool === "cursor" ? state.selectedElementId : null,
      historyMergeKey: null,
    })),
  setSelectedElementId: (selectedElementId) => set({ selectedElementId, historyMergeKey: null }),
  setActiveStrokeColor: (color) => set((state) => applyStyle(state, "strokeColor", color, "activeStrokeColor")),
  setActiveFillColor: (color) => set((state) => applyStyle(state, "fillColor", color, "activeFillColor")),
  setActiveStrokeWidth: (width) => set((state) => applyStyle(state, "strokeWidth", width, "activeStrokeWidth")),
  setActiveTextColor: (color) => set((state) => applyStyle(state, "textColor", color, "activeTextColor")),
  setActiveFontFamily: (font) => set((state) => applyStyle(state, "fontFamily", font, "activeFontFamily")),
  addElement: (element) =>
    set((state) => {
      const elements = [...state.elements, element];
      return { elements, ...commit(state, elements) };
    }),
  updateElementText: (id, text) =>
    set((state) => {
      const current = state.elements.find((element) => element.id === id);
      if (!current) return state;
      const elements = patchElement(state.elements, id, { text });
      if (!elements) return state;
      return { elements, ...commit(state, elements) };
    }),
  updateElementPosition: (id, x, y) =>
    set((state) => {
      const elements = patchElement(state.elements, id, { x, y });
      if (!elements) return state;
      return { elements, ...commit(state, elements) };
    }),
  updateElementGeometry: (id, geometry) =>
    set((state) => {
      const elements = patchElement(state.elements, id, geometry);
      if (!elements) return state;
      return { elements, ...commit(state, elements) };
    }),
  deleteElement: (id) =>
    set((state) => {
      const elements = state.elements.filter((element) => element.id !== id);
      if (elements.length === state.elements.length) return state;
      return {
        elements,
        selectedElementId: state.selectedElementId === id ? null : state.selectedElementId,
        ...commit(state, elements),
      };
    }),
  clearCanvas: () =>
    set((state) => {
      if (state.elements.length === 0) return state;
      const elements: CanvasElement[] = [];
      return {
        elements,
        selectedElementId: null,
        ...commit(state, elements),
      };
    }),
  undo: () =>
    set((state) => {
      if (state.historyStep <= 0) return state;
      const historyStep = state.historyStep - 1;
      return { historyStep, elements: state.history[historyStep], selectedElementId: null, historyMergeKey: null };
    }),
  redo: () =>
    set((state) => {
      if (state.historyStep >= state.history.length - 1) return state;
      const historyStep = state.historyStep + 1;
      return { historyStep, elements: state.history[historyStep], selectedElementId: null, historyMergeKey: null };
    }),
}));
