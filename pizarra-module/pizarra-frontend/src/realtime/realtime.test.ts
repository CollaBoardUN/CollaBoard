import { beforeEach, describe, expect, it } from "vitest";

import type { CanvasElement } from "../domain/models/canvas";
import { useBoardStore } from "../store/useBoardStore";
import { applyRemoteOps, isApplyingRemote, replaceBoardElements } from "./boardBridge";
import { applyOps, diffElements } from "./elementOps";
import { useRealtime } from "./realtimeStore";

const make = (id: string, extra: Partial<CanvasElement> = {}): CanvasElement => ({
  id,
  type: "rectangle",
  x: 0,
  y: 0,
  width: 10,
  height: 10,
  fillColor: "#fff",
  strokeColor: "#000",
  strokeWidth: 2,
  authorId: "ana",
  ...extra,
});

describe("diffElements", () => {
  it("detecta crear, mover y borrar", () => {
    const a = make("a");
    const b = make("b");
    const movedA = { ...a, x: 50, y: 60 };
    const c = make("c");

    expect(diffElements([a, b], [movedA, c])).toEqual([
      { op: "update", id: "a", patch: { x: 50, y: 60 } },
      { op: "add", element: c },
      { op: "delete", id: "b" },
    ]);
  });

  it("no genera operaciones si nada cambió", () => {
    const a = make("a");
    expect(diffElements([a], [a])).toEqual([]);
    expect(diffElements([a], [{ ...a }])).toEqual([]);
  });

  it("marca como null los campos opcionales que desaparecen", () => {
    const a = make("a", { text: "hola" });
    const withoutText: CanvasElement = { ...a, text: undefined };
    expect(diffElements([a], [withoutText])).toEqual([{ op: "update", id: "a", patch: { text: null } }]);
  });

  it("compara los puntos por valor", () => {
    const a = make("a", { type: "pencil", points: [0, 0, 1, 1] });
    expect(diffElements([a], [{ ...a, points: [0, 0, 1, 1] }])).toEqual([]);
    expect(diffElements([a], [{ ...a, points: [0, 0, 1, 2] }])).toHaveLength(1);
  });
});

describe("applyOps", () => {
  it("aplica add, update y delete conservando el orden", () => {
    const result = applyOps(
      [make("a"), make("b")],
      [
        { op: "update", id: "a", patch: { x: 7 } },
        { op: "add", element: make("c") },
        { op: "delete", id: "b" },
      ],
    );
    expect(result.map((e) => e.id)).toEqual(["a", "c"]);
    expect(result[0].x).toBe(7);
  });

  it("es idempotente", () => {
    const ops = [
      { op: "add" as const, element: make("a") },
      { op: "update" as const, id: "a", patch: { x: 5 } },
      { op: "delete" as const, id: "zzz" },
    ];
    const once = applyOps([], ops);
    expect(applyOps(once, ops)).toEqual(once);
  });

  it("ignora updates de elementos que no existen y devuelve la misma lista", () => {
    const list = [make("a")];
    expect(applyOps(list, [{ op: "update", id: "x", patch: { x: 1 } }])).toBe(list);
    expect(applyOps(list, [{ op: "delete", id: "x" }])).toBe(list);
  });

  it("un patch null borra el campo", () => {
    const [a] = applyOps([make("a", { text: "hola" })], [{ op: "update", id: "a", patch: { text: null } }]);
    expect(a).not.toHaveProperty("text");
  });
});

describe("boardBridge", () => {
  beforeEach(() => {
    replaceBoardElements([]);
    useRealtime.getState().reset();
  });

  it("marca los cambios remotos para no reenviarlos", () => {
    const seen: boolean[] = [];
    const unsubscribe = useBoardStore.subscribe(() => seen.push(isApplyingRemote()));
    applyRemoteOps([{ op: "add", element: make("r") }]);
    unsubscribe();
    expect(seen).toEqual([true]);
    expect(isApplyingRemote()).toBe(false);
    expect(useBoardStore.getState().elements.map((e) => e.id)).toEqual(["r"]);
  });

  it("deshacer un cambio propio no borra lo que dibujó otra persona", () => {
    const store = useBoardStore.getState();
    store.addElement(make("mio"));
    applyRemoteOps([{ op: "add", element: make("ajeno") }]);

    useBoardStore.getState().undo();
    expect(useBoardStore.getState().elements.map((e) => e.id)).toEqual(["ajeno"]);

    useBoardStore.getState().redo();
    expect(useBoardStore.getState().elements.map((e) => e.id).sort()).toEqual(["ajeno", "mio"]);
  });

  it("un borrado remoto tampoco reaparece al deshacer", () => {
    useBoardStore.getState().addElement(make("a"));
    useBoardStore.getState().addElement(make("b"));
    applyRemoteOps([{ op: "delete", id: "a" }]);

    useBoardStore.getState().undo();
    expect(useBoardStore.getState().elements.map((e) => e.id)).toEqual([]);
  });

  it("limpia la selección si el elemento seleccionado lo borró otra persona", () => {
    useBoardStore.getState().addElement(make("a"));
    useBoardStore.getState().setSelectedElementId("a");
    applyRemoteOps([{ op: "delete", id: "a" }]);
    expect(useBoardStore.getState().selectedElementId).toBeNull();
  });

  it("el sync reemplaza el estado y reinicia el historial", () => {
    useBoardStore.getState().addElement(make("viejo"));
    replaceBoardElements([make("nuevo")]);
    const state = useBoardStore.getState();
    expect(state.elements.map((e) => e.id)).toEqual(["nuevo"]);
    expect(state.historyStep).toBe(0);
    state.undo();
    expect(useBoardStore.getState().elements.map((e) => e.id)).toEqual(["nuevo"]);
  });
});
