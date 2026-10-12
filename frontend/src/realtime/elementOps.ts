/**
 * Funciones puras para convertir cambios del store en operaciones de red y
 * viceversa. Sin React ni WebSocket: fáciles de probar.
 */
import type { CanvasElement } from "../domain/models/canvas";
import type { ElementOp, ElementPatch } from "./protocol";

/** Campos sincronizados (los mismos que acepta el servidor en un `update`). */
const PATCHABLE = [
  "x",
  "y",
  "width",
  "height",
  "strokeWidth",
  "fillColor",
  "strokeColor",
  "textColor",
  "fontFamily",
  "points",
  "text",
] as const satisfies readonly (keyof CanvasElement)[];

const sameValue = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((value, index) => value === b[index]);
  }
  return false;
};

function changedFields(before: CanvasElement, after: CanvasElement): ElementPatch {
  const patch: Record<string, unknown> = {};
  for (const key of PATCHABLE) {
    if (sameValue(before[key], after[key])) continue;
    patch[key] = after[key] ?? null;
  }
  return patch as ElementPatch;
}

/** Operaciones necesarias para pasar de `prev` a `next` (crear, mover/editar, borrar). */
export function diffElements(prev: CanvasElement[], next: CanvasElement[]): ElementOp[] {
  if (prev === next) return [];
  const before = new Map(prev.map((element) => [element.id, element]));
  const ops: ElementOp[] = [];
  const seen = new Set<string>();

  for (const element of next) {
    seen.add(element.id);
    const old = before.get(element.id);
    if (!old) {
      ops.push({ op: "add", element });
    } else if (old !== element) {
      const patch = changedFields(old, element);
      if (Object.keys(patch).length > 0) ops.push({ op: "update", id: element.id, patch });
    }
  }
  for (const element of prev) {
    if (!seen.has(element.id)) ops.push({ op: "delete", id: element.id });
  }
  return ops;
}

/**
 * Aplica operaciones a una lista (sin mutarla). Es idempotente: repetir un
 * `add`, `update` o `delete` deja el mismo resultado. Devuelve la misma
 * referencia si nada cambió.
 */
export function applyOps(list: CanvasElement[], ops: ElementOp[]): CanvasElement[] {
  if (ops.length === 0) return list;
  // Un Map conserva el orden de inserción (= orden de apilado) y evita O(n·m).
  const byId = new Map(list.map((element) => [element.id, element]));
  let changed = false;

  for (const op of ops) {
    if (op.op === "add") {
      byId.set(op.element.id, op.element);
      changed = true;
    } else if (op.op === "delete") {
      changed = byId.delete(op.id) || changed;
    } else {
      const current = byId.get(op.id);
      if (!current) continue;
      const next: Record<string, unknown> = { ...current };
      for (const [key, value] of Object.entries(op.patch)) {
        if (value === null) delete next[key];
        else next[key] = value;
      }
      byId.set(op.id, next as unknown as CanvasElement);
      changed = true;
    }
  }
  return changed ? [...byId.values()] : list;
}
