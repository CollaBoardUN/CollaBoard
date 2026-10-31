/**
 * Puente entre los eventos remotos y `useBoardStore`, sin modificar ese store.
 *
 * Los cambios remotos se escriben con `setState` bajo una bandera para que el
 * suscriptor que envía los cambios locales no los reenvíe (eco infinito).
 *
 * Deshacer/rehacer: el store guarda "fotos" completas del tablero. Si un
 * `undo` local restaurara una foto vieja, borraría lo que dibujaron los demás.
 * Por eso cada cambio remoto también se aplica a todas las fotos del historial.
 * Los ecos propios actualizan la base confirmada en RealtimeClient y llegan
 * aquí por reconcileBoardElements, sin borrar el antes/después de la acción.
 */
import { useBoardStore } from "@/core/stores/useBoardStore";
import type { CanvasElement } from "@/core/domain/canvas";
import { applyOps, diffElements } from "./elementOps";
import type { ElementOp } from "./protocol";

let applyingRemote = false;

/** `true` mientras se escribe un cambio remoto en el store. */
export const isApplyingRemote = (): boolean => applyingRemote;

function asRemote(fn: () => void): void {
  const previous = applyingRemote;
  applyingRemote = true;
  try {
    fn();
  } finally {
    applyingRemote = previous;
  }
}

/** Reemplaza todo el tablero con el estado del servidor (conexión inicial o reconexión). */
export function replaceBoardElements(elements: CanvasElement[]): void {
  asRemote(() =>
    useBoardStore.setState({
      elements,
      selectedElementId: null,
      history: [elements],
      historyStep: 0,
      historyMergeKey: null,
    }),
  );
}

/** Actualiza solo el paso activo: una confirmación propia no es una acción nueva. */
export function reconcileBoardElements(elements: CanvasElement[]): void {
  asRemote(() =>
    useBoardStore.setState((state) => {
      const history: CanvasElement[][] = [];
      let historyStep = 0;
      state.history.forEach((snapshot, step) => {
        const next = step === state.historyStep ? elements : snapshot;
        // Compactar después de proyectar los pendientes: un patch remoto
        // puede igualar fotos que una edición propia pendiente aún distingue.
        if (!history.length || diffElements(history[history.length - 1], next).length) history.push(next);
        if (step === state.historyStep) historyStep = history.length - 1;
      });
      return {
        elements,
        history,
        historyStep,
        selectedElementId: elements.some((element) => element.id === state.selectedElementId)
          ? state.selectedElementId : null,
      };
    }),
  );
}

/** Aplica un lote de otra conexión; los ecos propios se reconcilian por separado. */
export function applyRemoteOps(ops: ElementOp[]): void {
  asRemote(() =>
    useBoardStore.setState((state) => {
      const deleted = new Set(ops.flatMap((op) => (op.op === "delete" ? [op.id] : [])));
      // Una edición ajena sobre una figura que creé también debe sobrevivir
      // al undo de su creación. Se conserva la primera versión local conocida
      // con el patch remoto, sin arrastrar movimientos propios posteriores.
      const protectedAdds: ElementOp[] = [];
      const visible = new Set(state.elements.map((element) => element.id));
      const firstById = new Map<string, CanvasElement>();
      for (const snapshot of state.history) {
        for (const element of snapshot) {
          if (!firstById.has(element.id)) firstById.set(element.id, element);
        }
      }
      for (const op of ops) {
        if (op.op !== "update" || !visible.has(op.id)) continue;
        const first = firstById.get(op.id);
        if (first) protectedAdds.push({ op: "add", element: first });
      }
      const history = state.history.map((snapshot) => {
        const ids = new Set(snapshot.map((element) => element.id));
        const missing = protectedAdds.filter((op) => op.op === "add" && !ids.has(op.element.id));
        return applyOps(applyOps(snapshot, missing), ops);
      });
      return {
        elements: applyOps(state.elements, ops),
        history,
        historyMergeKey: null,
        selectedElementId:
          state.selectedElementId && deleted.has(state.selectedElementId) ? null : state.selectedElementId,
      };
    }),
  );
}
