"use client";

import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  Arrow,
  Circle,
  Group,
  Layer,
  Line,
  Rect,
  RegularPolygon,
  Stage,
  Star,
  Text,
  Transformer,
} from "react-konva";
import { Html } from "react-konva-utils";
import type Konva from "konva";

import {
  DEFAULT_FONT_FAMILY,
  DEFAULT_TEXT_COLOR,
  STICKY_DEFAULTS,
  TRANSPARENT_FILL,
  isDragDrawingTool,
  type CanvasElement,
  type CanvasElementGeometry,
  type CanvasElementType,
} from "@/core/domain/canvas";
import { useBoardStore } from "@/core/stores/useBoardStore";
import { newId } from "@/core/lib/id";
import { useRealtime } from "@/core/realtime/realtimeStore";
import { FloatingContextToolbar } from "./FloatingContextToolbar";

interface CanvasBoardProps {
  authorId?: string;
  /** Rol `viewer`: se ve el tablero y los trazos ajenos, pero no se puede dibujar ni editar. */
  readOnly?: boolean;
}

interface CanvasSize {
  width: number;
  height: number;
}

interface Point {
  x: number;
  y: number;
}

type CanvasPointerEvent = Konva.KonvaEventObject<MouseEvent | TouchEvent>;

const SELECTION_COLOR = "#6366F1";
const MIN_ELEMENT_SIZE = 8;
const MIN_DRAW_DISTANCE = 2;
const STICKY_PADDING = 12;
const STICKY_FONT_SIZE = 16;
const STICKY_LINE_HEIGHT = 1.4;
const CORNER_ANCHORS = ["top-left", "top-right", "bottom-left", "bottom-right"];
const ALL_ANCHORS = [...CORNER_ANCHORS, "top-center", "middle-right", "bottom-center", "middle-left"];

/** Shapes rendered from their center (Konva origin) with a radius of max(width, height) / 2. */
const CENTERED_TYPES = new Set<CanvasElementType>(["circle", "triangle", "star"]);
/** Shapes whose geometry lives in `points`, relative to x/y. */
const POINT_TYPES = new Set<CanvasElementType>(["pencil", "line", "arrow"]);

const TOOL_CURSORS: Partial<Record<CanvasElementType, string>> = {
  cursor: "default",
  eraser: "not-allowed",
  sticky: "copy",
};

const initialSize = (): CanvasSize => ({ width: window.innerWidth, height: window.innerHeight });
const stickyFill = (element: CanvasElement) =>
  element.fillColor === TRANSPARENT_FILL ? "#FFFFFF" : element.fillColor;

/** Computes the visual bounding box of any element on the canvas. */
function getElementBounds(element: CanvasElement): { x: number; y: number; width: number; height: number } {
  if (CENTERED_TYPES.has(element.type)) {
    const diameter = Math.max(element.width, element.height);
    return {
      x: element.x + element.width / 2 - diameter / 2,
      y: element.y + element.height / 2 - diameter / 2,
      width: diameter,
      height: diameter,
    };
  }
  if (!POINT_TYPES.has(element.type)) {
    return { x: element.x, y: element.y, width: element.width, height: element.height };
  }

  const points = element.points ?? [0, 0];
  const xs = points.filter((_, index) => index % 2 === 0);
  const ys = points.filter((_, index) => index % 2 === 1);
  const minX = xs.length > 0 ? Math.min(...xs) : 0;
  const minY = ys.length > 0 ? Math.min(...ys) : 0;
  const maxX = xs.length > 0 ? Math.max(...xs) : 0;
  const maxY = ys.length > 0 ? Math.max(...ys) : 0;
  return {
    x: element.x + minX,
    y: element.y + minY,
    width: Math.max(maxX - minX, 1),
    height: Math.max(maxY - minY, 1),
  };
}

/** A drag that barely moved should not leave invisible, un-erasable elements behind. */
function hasVisibleSize(element: CanvasElement) {
  if (element.type === "pencil") return (element.points?.length ?? 0) > 2;
  if (element.type === "line" || element.type === "arrow") {
    return Math.abs(element.width) >= MIN_DRAW_DISTANCE || Math.abs(element.height) >= MIN_DRAW_DISTANCE;
  }
  if (CENTERED_TYPES.has(element.type)) return Math.max(element.width, element.height) >= MIN_DRAW_DISTANCE;
  return element.width >= MIN_DRAW_DISTANCE && element.height >= MIN_DRAW_DISTANCE;
}

/**
 * Converts the scale applied by the Transformer into real geometry and resets the node scale,
 * so the store never holds scaled nodes and stroke widths stay constant.
 */
function readTransformedGeometry(element: CanvasElement, node: Konva.Node): CanvasElementGeometry {
  const scaleX = Math.abs(node.scaleX());
  const scaleY = Math.abs(node.scaleY());
  node.scaleX(1);
  node.scaleY(1);

  if (POINT_TYPES.has(element.type)) {
    return {
      x: node.x(),
      y: node.y(),
      width: element.width * scaleX,
      height: element.height * scaleY,
      points: (element.points ?? []).map((value, index) => (index % 2 === 0 ? value * scaleX : value * scaleY)),
    };
  }

  const width = Math.max(MIN_ELEMENT_SIZE, element.width * scaleX);
  const height = Math.max(MIN_ELEMENT_SIZE, element.height * scaleY);
  if (CENTERED_TYPES.has(element.type)) {
    return { x: node.x() - width / 2, y: node.y() - height / 2, width, height };
  }
  return { x: node.x(), y: node.y(), width, height };
}

/** Rejects only resizes that shrink a box below the minimum, so thin lines can still be stretched. */
const limitBoundBox = <Box extends { width: number; height: number }>(oldBox: Box, newBox: Box): Box => {
  const tooSmall = (next: number, prev: number) => Math.abs(next) < MIN_ELEMENT_SIZE && Math.abs(next) < Math.abs(prev);
  return tooSmall(newBox.width, oldBox.width) || tooSmall(newBox.height, oldBox.height) ? oldBox : newBox;
};

interface StickyNoteEditorProps {
  element: CanvasElement;
  onCommit: (text: string) => void;
}

/**
 * Transparent textarea overlaid exactly on a shape or note.
 * Commits on blur; Escape or Ctrl/Cmd+Enter also finish editing.
 */
function StickyNoteEditor({ element, onCommit }: StickyNoteEditorProps) {
  const bounds = getElementBounds(element);
  const textColor = element.textColor ?? DEFAULT_TEXT_COLOR;
  const fontFamily = element.fontFamily ?? DEFAULT_FONT_FAMILY;

  return (
    <Html groupProps={{ x: bounds.x, y: bounds.y }}>
      <textarea
        data-sticky-editor=""
        aria-label="Editar texto"
        autoFocus
        defaultValue={element.text ?? ""}
        style={{
          display: "block",
          boxSizing: "border-box",
          width: Math.max(bounds.width, 60),
          height: Math.max(bounds.height, 40),
          margin: 0,
          padding: STICKY_PADDING,
          border: "none",
          borderRadius: 4,
          outline: "none",
          boxShadow: `inset 0 0 0 2px ${SELECTION_COLOR}66`,
          background: "transparent",
          resize: "none",
          overflow: "hidden",
          color: textColor,
          caretColor: SELECTION_COLOR,
          font: `${STICKY_FONT_SIZE}px/${STICKY_LINE_HEIGHT} ${fontFamily}`,
          textAlign: "center",
        }}
        onBlur={(event) => onCommit(event.currentTarget.value)}
        onKeyDown={(event) => {
          const confirm = event.key === "Enter" && (event.metaKey || event.ctrlKey);
          if (event.key === "Escape" || confirm) {
            event.preventDefault();
            event.currentTarget.blur();
          }
        }}
      />
    </Html>
  );
}

export function CanvasBoard({ authorId = "local-user", readOnly = false }: CanvasBoardProps) {
  const elements = useBoardStore((state) => state.elements);
  const selectedTool = useBoardStore((state) => state.selectedTool);
  const selectedElementId = useBoardStore((state) => state.selectedElementId);
  const activeStrokeColor = useBoardStore((state) => state.activeStrokeColor);
  const activeFillColor = useBoardStore((state) => state.activeFillColor);
  const activeStrokeWidth = useBoardStore((state) => state.activeStrokeWidth);
  const activeTextColor = useBoardStore((state) => state.activeTextColor);
  const activeFontFamily = useBoardStore((state) => state.activeFontFamily);
  const addElement = useBoardStore((state) => state.addElement);
  const deleteElement = useBoardStore((state) => state.deleteElement);
  const updateElementText = useBoardStore((state) => state.updateElementText);
  const updateElementPosition = useBoardStore((state) => state.updateElementPosition);
  const updateElementGeometry = useBoardStore((state) => state.updateElementGeometry);
  const setActiveStrokeColor = useBoardStore((state) => state.setActiveStrokeColor);
  const setActiveFillColor = useBoardStore((state) => state.setActiveFillColor);
  const setActiveStrokeWidth = useBoardStore((state) => state.setActiveStrokeWidth);
  const setActiveTextColor = useBoardStore((state) => state.setActiveTextColor);
  const setActiveFontFamily = useBoardStore((state) => state.setActiveFontFamily);
  const setSelectedElementId = useBoardStore((state) => state.setSelectedElementId);
  // Tiempo real: trazos en curso de los demás, y publicación del mío.
  const remoteDrafts = useRealtime((state) => state.drafts);
  const setLocalDraft = useRealtime((state) => state.setLocalDraft);
  const [size, setSize] = useState<CanvasSize>(initialSize);
  const [draft, setDraft] = useState<CanvasElement | null>(null);
  const [editingElementId, setEditingElementId] = useState<string | null>(null);
  const draftRef = useRef<CanvasElement | null>(null);
  const drawOrigin = useRef<Point | null>(null);
  const layerRef = useRef<Konva.Layer>(null);
  const transformerRef = useRef<Konva.Transformer>(null);

  const isCursorMode = !readOnly && selectedTool === "cursor";
  const editingElement = editingElementId
    ? elements.find((element) => element.id === editingElementId)
    : undefined;
  const selectedElement = selectedElementId
    ? elements.find((element) => element.id === selectedElementId)
    : undefined;
  // The Transformer only exists in cursor mode and never competes with the text editor.
  const transformTarget = isCursorMode && !editingElement ? selectedElement : undefined;
  const transformTargetId = transformTarget?.id ?? null;

  useEffect(() => {
    setLocalDraft(draft);
  }, [draft, setLocalDraft]);

  useEffect(() => {
    const resize = () => setSize({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);

  // Sync the imperative Konva Transformer with the selected node.
  useEffect(() => {
    const transformer = transformerRef.current;
    const layer = layerRef.current;
    if (!transformer || !layer) return;
    const node = transformTargetId
      ? layer.findOne((candidate: Konva.Node) => candidate.id() === transformTargetId)
      : undefined;
    transformer.nodes(node ? [node] : []);
    transformer.forceUpdate();
    layer.batchDraw();
  }, [transformTargetId, elements]);

  /**
   * A pointer-down on the canvas while a note/shape is being edited only commits the text.
   * Returns true when the event was consumed by that commit.
   */
  const finishEditingFromPointer = () => {
    if (!editingElementId) return false;
    if (!editingElement) {
      setEditingElementId(null);
      return false;
    }
    const focused = document.activeElement;
    if (focused instanceof HTMLTextAreaElement && focused.dataset.stickyEditor !== undefined) focused.blur();
    setEditingElementId(null);
    return true;
  };

  const beginDrawing = (point: Point) => {
    const element: CanvasElement = {
      id: newId(),
      type: selectedTool,
      x: point.x,
      y: point.y,
      width: 0,
      height: 0,
      fillColor: activeFillColor,
      strokeColor: activeStrokeColor,
      strokeWidth: activeStrokeWidth,
      textColor: activeTextColor,
      fontFamily: activeFontFamily,
      authorId,
      points: [0, 0],
    };
    drawOrigin.current = point;
    draftRef.current = element;
    setDraft(element);
  };

  const continueDrawing = useCallback((stage: Konva.Stage | null) => {
    const current = draftRef.current;
    const origin = drawOrigin.current;
    const point = stage?.getPointerPosition();
    if (!current || !origin || !point) return;

    const dx = point.x - origin.x;
    const dy = point.y - origin.y;
    const next: CanvasElement =
      current.type === "pencil"
        ? { ...current, points: [...(current.points ?? []), dx, dy] }
        : current.type === "line" || current.type === "arrow"
          ? { ...current, width: dx, height: dy, points: [0, 0, dx, dy] }
          : {
              ...current,
              x: Math.min(origin.x, point.x),
              y: Math.min(origin.y, point.y),
              width: Math.abs(dx),
              height: Math.abs(dy),
            };
    draftRef.current = next;
    setDraft(next);
  }, []);

  const finishDrawing = useCallback(() => {
    const completed = draftRef.current;
    if (completed && hasVisibleSize(completed)) addElement(completed);
    draftRef.current = null;
    drawOrigin.current = null;
    setDraft(null);
  }, [addElement]);

  const createSticky = (point: Point) => {
    const sticky: CanvasElement = {
      id: newId(),
      type: "sticky",
      x: point.x - STICKY_DEFAULTS.width / 2,
      y: point.y - STICKY_DEFAULTS.height / 2,
      width: STICKY_DEFAULTS.width,
      height: STICKY_DEFAULTS.height,
      fillColor: activeFillColor === TRANSPARENT_FILL ? STICKY_DEFAULTS.fillColor : activeFillColor,
      strokeColor: activeStrokeColor,
      strokeWidth: 1,
      textColor: activeTextColor,
      fontFamily: activeFontFamily,
      authorId,
      text: "",
    };
    addElement(sticky);
    setEditingElementId(sticky.id);
  };

  const handleStagePointerDown = (event: CanvasPointerEvent) => {
    const stage = event.target.getStage();
    if (readOnly || !stage || finishEditingFromPointer()) return;

    if (selectedTool === "cursor") {
      if (event.target === stage) setSelectedElementId(null);
      return;
    }
    if (selectedTool === "eraser") return;

    const point = stage.getPointerPosition();
    if (!point) return;
    if (selectedTool === "sticky") createSticky(point);
    else if (isDragDrawingTool(selectedTool)) beginDrawing(point);
  };

  /** Element-level pointer-down: selection (cursor), deletion (eraser) or letting sticky edits through. */
  const handleElementPointerDown = (event: CanvasPointerEvent, element: CanvasElement) => {
    if (readOnly) return;
    if (finishEditingFromPointer()) {
      event.cancelBubble = true;
      return;
    }
    if (selectedTool === "cursor") {
      setSelectedElementId(element.id);
    } else if (selectedTool === "eraser") {
      event.cancelBubble = true;
      deleteElement(element.id);
    } else if (selectedTool === "sticky" && element.type === "sticky") {
      event.cancelBubble = true;
    }
  };

  const handleDragEnd = (event: Konva.KonvaEventObject<DragEvent>, element: CanvasElement) => {
    const centered = CENTERED_TYPES.has(element.type);
    updateElementPosition(
      element.id,
      event.target.x() - (centered ? element.width / 2 : 0),
      event.target.y() - (centered ? element.height / 2 : 0),
    );
  };

  const handleTransformEnd = (event: Konva.KonvaEventObject<Event>, element: CanvasElement) => {
    updateElementGeometry(element.id, readTransformedGeometry(element, event.target));
  };

  const startEditing = (element: CanvasElement) => {
    if (readOnly) return;
    if (selectedTool !== "cursor" && selectedTool !== "sticky") return;
    setEditingElementId(element.id);
  };

  const commitStickyText = (id: string, text: string) => {
    updateElementText(id, text);
    setEditingElementId(null);
  };

  const renderElement = (element: CanvasElement, interactive = true): ReactNode => {
    const isEditing = editingElementId === element.id;
    const interactionProps = interactive
      ? {
          id: element.id,
          draggable: isCursorMode && !isEditing,
          onMouseDown: (event: CanvasPointerEvent) => handleElementPointerDown(event, element),
          onTouchStart: (event: CanvasPointerEvent) => handleElementPointerDown(event, element),
          onDblClick: () => startEditing(element),
          onDblTap: () => startEditing(element),
          onDragEnd: (event: Konva.KonvaEventObject<DragEvent>) => handleDragEnd(event, element),
          onTransformEnd: (event: Konva.KonvaEventObject<Event>) => handleTransformEnd(event, element),
        }
      : { listening: false };

    const elementTextColor = element.textColor ?? DEFAULT_TEXT_COLOR;
    const elementFontFamily = element.fontFamily ?? DEFAULT_FONT_FAMILY;

    if (element.type === "sticky") {
      return (
        <Group
          key={element.id}
          x={element.x}
          y={element.y}
          {...interactionProps}
        >
          <Rect
            width={element.width}
            height={element.height}
            fill={stickyFill(element)}
            stroke={element.strokeColor}
            strokeWidth={1}
            strokeScaleEnabled={false}
            cornerRadius={4}
            shadowColor="black"
            shadowBlur={5}
            shadowOpacity={0.2}
            shadowOffset={{ x: 2, y: 2 }}
          />
          {!isEditing && (
            <Text
              x={STICKY_PADDING}
              y={STICKY_PADDING}
              width={Math.max(element.width - STICKY_PADDING * 2, 0)}
              height={Math.max(element.height - STICKY_PADDING * 2, 0)}
              text={element.text ?? ""}
              fill={elementTextColor}
              fontSize={STICKY_FONT_SIZE}
              lineHeight={STICKY_LINE_HEIGHT}
              fontFamily={elementFontFamily}
              align="center"
              verticalAlign="middle"
              wrap="word"
              ellipsis
              listening={false}
            />
          )}
        </Group>
      );
    }

    const fill = element.fillColor === TRANSPARENT_FILL ? "rgba(255, 255, 255, 0.001)" : element.fillColor;
    const common = {
      x: element.x,
      y: element.y,
      stroke: element.strokeColor,
      strokeWidth: element.strokeWidth,
      strokeScaleEnabled: false,
      fill,
      ...interactionProps,
    };
    const centerX = element.x + element.width / 2;
    const centerY = element.y + element.height / 2;
    const radius = Math.max(element.width, element.height) / 2;
    const hitStrokeWidth = Math.max(element.strokeWidth, 12);

    let shape: ReactNode;
    switch (element.type) {
      case "pencil":
      case "line":
        shape = (
          <Line
            key={element.id}
            {...common}
            fill={undefined}
            points={element.points ?? [0, 0]}
            lineCap="round"
            lineJoin="round"
            hitStrokeWidth={hitStrokeWidth}
          />
        );
        break;
      case "arrow":
        shape = (
          <Arrow
            key={element.id}
            {...common}
            points={element.points ?? [0, 0, 0, 0]}
            pointerLength={12}
            pointerWidth={12}
            fill={element.strokeColor}
            hitStrokeWidth={hitStrokeWidth}
          />
        );
        break;
      case "rectangle":
        shape = <Rect key={element.id} {...common} width={element.width} height={element.height} />;
        break;
      case "circle":
        shape = <Circle key={element.id} {...common} x={centerX} y={centerY} radius={radius} />;
        break;
      case "triangle":
        shape = <RegularPolygon key={element.id} {...common} x={centerX} y={centerY} radius={radius} sides={3} />;
        break;
      case "star":
        shape = (
          <Star
            key={element.id}
            {...common}
            x={centerX}
            y={centerY}
            numPoints={5}
            innerRadius={radius * 0.45}
            outerRadius={radius}
          />
        );
        break;
      default:
        return null;
    }

    // Render centered text if element has text and is not being edited
    if (!isEditing && element.text) {
      let textX = element.x + 8;
      let textY = element.y + 8;
      let textWidth = Math.max(element.width - 16, 1);
      let textHeight = Math.max(element.height - 16, 1);

      if (CENTERED_TYPES.has(element.type)) {
        const innerSide = Math.max(radius * 1.3, 10);
        textX = centerX - innerSide / 2;
        textY = centerY - innerSide / 2;
        textWidth = innerSide;
        textHeight = innerSide;
      } else if (element.type === "arrow" || element.type === "line") {
        const bounds = getElementBounds(element);
        textX = bounds.x;
        textY = bounds.y + bounds.height / 2 - 12;
        textWidth = Math.max(bounds.width, 40);
        textHeight = 24;
      }

      return (
        <Fragment key={element.id}>
          {shape}
          <Text
            key={`${element.id}-text`}
            x={textX}
            y={textY}
            width={textWidth}
            height={textHeight}
            text={element.text}
            fill={elementTextColor}
            fontSize={STICKY_FONT_SIZE}
            lineHeight={STICKY_LINE_HEIGHT}
            fontFamily={elementFontFamily}
            align="center"
            verticalAlign="middle"
            wrap="word"
            ellipsis
            listening={false}
          />
        </Fragment>
      );
    }

    return shape;
  };

  const keepsRatio = transformTarget ? CENTERED_TYPES.has(transformTarget.type) : false;

  return (
    <div
      className="fixed inset-0"
      style={{
        position: "fixed",
        inset: 0,
        background: "#F8FAFC",
        fontFamily: DEFAULT_FONT_FAMILY,
        cursor: readOnly ? "default" : (TOOL_CURSORS[selectedTool] ?? "crosshair"),
      }}
      aria-label={readOnly ? "Lienzo colaborativo (solo lectura)" : "Lienzo colaborativo"}
      data-readonly={readOnly || undefined}
    >
      <Stage
        width={size.width}
        height={size.height}
        onMouseDown={handleStagePointerDown}
        onTouchStart={handleStagePointerDown}
        onMouseMove={(event) => continueDrawing(event.target.getStage())}
        onTouchMove={(event) => continueDrawing(event.target.getStage())}
        onMouseUp={finishDrawing}
        onTouchEnd={finishDrawing}
        onMouseLeave={finishDrawing}
      >
        <Layer ref={layerRef}>
          {elements.map((element) => renderElement(element))}
          {draft && renderElement(draft, false)}
          {Object.entries(remoteDrafts).map(([conn, remoteDraft]) => (
            <Fragment key={conn}>{renderElement(remoteDraft, false)}</Fragment>
          ))}
          <Transformer
            ref={transformerRef}
            rotateEnabled={false}
            flipEnabled={false}
            keepRatio={keepsRatio}
            enabledAnchors={keepsRatio ? CORNER_ANCHORS : ALL_ANCHORS}
            anchorSize={9}
            anchorCornerRadius={2}
            anchorStroke={SELECTION_COLOR}
            anchorFill="#FFFFFF"
            borderStroke={SELECTION_COLOR}
            padding={4}
            boundBoxFunc={limitBoundBox}
          />
          {/* Menú flotante contextual tipo Miro sobre el elemento seleccionado */}
          {isCursorMode && selectedElement && !editingElement && (
            <FloatingContextToolbar
              element={selectedElement}
              bounds={getElementBounds(selectedElement)}
              onStrokeColorChange={setActiveStrokeColor}
              onFillColorChange={setActiveFillColor}
              onStrokeWidthChange={setActiveStrokeWidth}
              onTextColorChange={setActiveTextColor}
              onFontFamilyChange={setActiveFontFamily}
              onDelete={deleteElement}
            />
          )}
          {editingElement && (
            <StickyNoteEditor
              key={editingElement.id}
              element={editingElement}
              onCommit={(text) => commitStickyText(editingElement.id, text)}
            />
          )}
        </Layer>
      </Stage>
    </div>
  );
}
