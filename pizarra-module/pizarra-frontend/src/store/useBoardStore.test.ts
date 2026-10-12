import {
  DEFAULT_FONT_FAMILY,
  DEFAULT_TEXT_COLOR,
  type CanvasElement,
} from "../domain/models/canvas";
import { useBoardStore } from "./useBoardStore";

const initialState = useBoardStore.getState();

const makeElement = (over: Partial<CanvasElement> = {}): CanvasElement => ({
  id: "e1",
  type: "rectangle",
  x: 10,
  y: 20,
  width: 100,
  height: 50,
  fillColor: "#FEF08A",
  strokeColor: "#1E293B",
  strokeWidth: 3,
  authorId: "ana",
  ...over,
});

const store = () => useBoardStore.getState();

beforeEach(() => {
  useBoardStore.setState(initialState, true);
});

describe("useBoardStore — colores y estilos", () => {
  it("sin selección, los colores solo cambian los valores por defecto (sin historial)", () => {
    store().addElement(makeElement());
    store().setActiveStrokeColor("#FF0000");
    store().setActiveFillColor("#00FF00");

    expect(store().activeStrokeColor).toBe("#FF0000");
    expect(store().activeFillColor).toBe("#00FF00");
    expect(store().elements[0]).toMatchObject({ strokeColor: "#1E293B", fillColor: "#FEF08A" });
    expect(store().historyStep).toBe(1);
  });

  it("con selección, borde y relleno se aplican al elemento de forma independiente", () => {
    store().addElement(makeElement());
    store().setSelectedTool("cursor");
    store().setSelectedElementId("e1");

    store().setActiveStrokeColor("#FF0000");
    expect(store().elements[0]).toMatchObject({ strokeColor: "#FF0000", fillColor: "#FEF08A" });

    store().setActiveFillColor("transparent");
    expect(store().elements[0]).toMatchObject({ strokeColor: "#FF0000", fillColor: "transparent" });
    // Los valores por defecto para nuevas figuras no se tocan.
    expect(store().activeStrokeColor).toBe("#1E293B");
    expect(store().activeFillColor).toBe("#FEF08A");
  });

  it("con selección, el grosor de trazo se aplica al elemento seleccionado", () => {
    store().addElement(makeElement());
    store().setSelectedTool("cursor");
    store().setSelectedElementId("e1");

    store().setActiveStrokeWidth(8);
    expect(store().elements[0].strokeWidth).toBe(8);
    // El grosor por defecto para futuras figuras no se altera al editar una figura seleccionada
    expect(store().activeStrokeWidth).toBe(3);
  });

  it("con selección, el color de texto y tipografía se aplican al elemento seleccionado", () => {
    store().addElement(makeElement());
    store().setSelectedTool("cursor");
    store().setSelectedElementId("e1");

    store().setActiveTextColor("#EF4444");
    store().setActiveFontFamily("Georgia, serif");

    expect(store().elements[0].textColor).toBe("#EF4444");
    expect(store().elements[0].fontFamily).toBe("Georgia, serif");
    // Defaults para futuras figuras no se tocan
    expect(store().activeTextColor).toBe(DEFAULT_TEXT_COLOR);
    expect(store().activeFontFamily).toBe(DEFAULT_FONT_FAMILY);
  });

  it("agrupa los cambios continuos del selector de color en un solo paso de deshacer", () => {
    store().addElement(makeElement());
    store().setSelectedElementId("e1");
    store().setActiveStrokeColor("#111111");
    store().setActiveStrokeColor("#222222");
    store().setActiveStrokeColor("#333333");

    expect(store().history).toHaveLength(3);
    store().undo();
    expect(store().elements[0].strokeColor).toBe("#1E293B");
    store().redo();
    expect(store().elements[0].strokeColor).toBe("#333333");
  });

  it("borde y relleno son pasos de historial distintos", () => {
    store().addElement(makeElement());
    store().setSelectedElementId("e1");
    store().setActiveStrokeColor("#111111");
    store().setActiveFillColor("#222222");

    store().undo();
    expect(store().elements[0]).toMatchObject({ strokeColor: "#111111", fillColor: "#FEF08A" });
  });

  it("cambiar a una herramienta de dibujo descarta la selección", () => {
    store().addElement(makeElement());
    store().setSelectedTool("cursor");
    store().setSelectedElementId("e1");
    store().setSelectedTool("pencil");

    expect(store().selectedElementId).toBeNull();
    store().setActiveStrokeColor("#FF0000");
    expect(store().elements[0].strokeColor).toBe("#1E293B");
  });
});

describe("useBoardStore — edición e historial", () => {
  it("borrar elimina el elemento y se puede deshacer", () => {
    store().addElement(makeElement());
    store().setSelectedElementId("e1");
    store().deleteElement("e1");

    expect(store().elements).toHaveLength(0);
    expect(store().selectedElementId).toBeNull();
    store().undo();
    expect(store().elements.map((element) => element.id)).toEqual(["e1"]);
  });

  it("redimensionar guarda la geometría como un solo paso", () => {
    store().addElement(makeElement());
    store().updateElementGeometry("e1", { x: 0, y: 0, width: 200, height: 80 });

    expect(store().elements[0]).toMatchObject({ x: 0, y: 0, width: 200, height: 80 });
    store().undo();
    expect(store().elements[0]).toMatchObject({ x: 10, y: 20, width: 100, height: 50 });
  });

  it("no crea pasos de historial cuando nada cambia", () => {
    store().addElement(makeElement({ type: "sticky", text: "hola" }));
    store().updateElementPosition("e1", 10, 20);
    store().updateElementGeometry("e1", { width: 100 });
    store().updateElementText("e1", "hola");

    expect(store().history).toHaveLength(2);
  });

  it("todas las figuras pueden guardar texto", () => {
    store().addElement(makeElement({ id: "s1", type: "sticky", text: "" }));
    store().addElement(makeElement({ id: "r1", type: "rectangle" }));
    store().updateElementText("s1", "Idea");
    store().updateElementText("r1", "Rectángulo con texto");

    expect(store().elements.find((element) => element.id === "s1")?.text).toBe("Idea");
    expect(store().elements.find((element) => element.id === "r1")?.text).toBe("Rectángulo con texto");
  });

  it("una nueva acción después de deshacer descarta el futuro", () => {
    store().addElement(makeElement({ id: "a" }));
    store().addElement(makeElement({ id: "b" }));
    store().undo();
    store().addElement(makeElement({ id: "c" }));

    expect(store().elements.map((element) => element.id)).toEqual(["a", "c"]);
    store().redo();
    expect(store().elements.map((element) => element.id)).toEqual(["a", "c"]);
  });
});
