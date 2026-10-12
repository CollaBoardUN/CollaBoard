/** Tools supported by the collaborative board canvas. */
export type CanvasElementType =
  | "cursor"
  | "pencil"
  | "line"
  | "rectangle"
  | "circle"
  | "triangle"
  | "star"
  | "arrow"
  | "sticky"
  /** Erasing removes a vector element; it is not stored as a painted stroke. */
  | "eraser";

/** Tools that act on existing elements instead of producing new ones. */
export type InteractionTool = Extract<CanvasElementType, "cursor" | "eraser">;

/** Element types that are actually persisted in the board. */
export type DrawableElementType = Exclude<CanvasElementType, InteractionTool>;

/** Shared, transport-friendly shape representation for canvas elements. */
export interface CanvasElement {
  id: string;
  type: CanvasElementType;
  x: number;
  y: number;
  width: number;
  height: number;
  fillColor: string;
  strokeColor: string;
  strokeWidth: number;
  authorId: string;
  /** Coordinates relative to x/y, used by freehand strokes and the line tool. */
  points?: number[];
  /** Text content persisted with sticky-notes or shapes. */
  text?: string;
  /** Color of the text inside the shape or note. */
  textColor?: string;
  /** Typography family of the text inside the shape or note. */
  fontFamily?: string;
}

/** Style properties that the toolbar can apply to new or selected elements. */
export type CanvasElementStyle = Pick<
  CanvasElement,
  "strokeColor" | "fillColor" | "strokeWidth" | "textColor" | "fontFamily"
>;

/** Geometry properties that can change when an element is moved or resized. */
export type CanvasElementGeometry = Partial<Pick<CanvasElement, "x" | "y" | "width" | "height" | "points">>;

/** Value used in `fillColor` to represent "no fill". */
export const TRANSPARENT_FILL = "transparent";

/** Defaults for sticky notes created with a single click. */
export const STICKY_DEFAULTS = {
  width: 150,
  height: 150,
  fillColor: "#FEF08A",
} as const;

export const DEFAULT_TEXT_COLOR = "#111827";
export const DEFAULT_FONT_FAMILY = "Inter, sans-serif";

export const FONT_FAMILY_OPTIONS = [
  { value: "Inter, sans-serif", label: "Sans" },
  { value: "Georgia, serif", label: "Serif" },
  { value: "monospace", label: "Mono" },
  { value: "Caveat, cursive", label: "Cursive" },
] as const;

export const HEX_COLOR_REGEX = /^#[0-9a-f]{6}$/i;

/** `<input type="color">` only accepts #rrggbb values. */
export const toColorInputValue = (color: string, fallback: string): string =>
  HEX_COLOR_REGEX.test(color) ? color : fallback;

/** Tools that create elements by dragging the pointer across the canvas. */
export const DRAG_DRAWING_TOOLS: readonly CanvasElementType[] = [
  "pencil",
  "line",
  "rectangle",
  "circle",
  "triangle",
  "star",
  "arrow",
];

export const isDragDrawingTool = (tool: CanvasElementType): boolean => DRAG_DRAWING_TOOLS.includes(tool);
