/**
 * Puente entre los eventos remotos y `useBoardStore`, sin modificar ese store.
 *
 * Los cambios remotos se escriben con `setState` bajo una bandera para que el
 * suscriptor que envía los cambios locales no los reenvíe (eco infinito).
 *
 * Deshacer/rehacer: el store guarda "fotos" completas del tablero. Si un
 * `undo` local restaurara una foto vieja, borraría lo que dibujaron los demás.
 * Por eso cada cambio remoto también se aplica a todas las fotos del historial.
 */
import { useBoardStore } from "../store/useBoardStore";
import type { CanvasElement } from "../domain/models/canvas";
import { applyOps } from "./elementOps";
import type { ElementOp } from "./protocol";

let applyingRemote = false;

/** `true` mientras se escribe un cambio remoto en el store. */
export const isApplyingRemote = (): boolean => applyingRemote;

function asRemote(fn: () => void): void {
  applyingRemote = true;
  try {
    fn();
  } finally {
    applyingRemote = false;
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

/** Aplica un lote de operaciones de otro usuario (o el eco de las mías). */
export function applyRemoteOps(ops: ElementOp[]): void {
  asRemote(() =>
    useBoardStore.setState((state) => {
      const deleted = new Set(ops.flatMap((op) => (op.op === "delete" ? [op.id] : [])));
      return {
        elements: applyOps(state.elements, ops),
        history: state.history.map((snapshot) => applyOps(snapshot, ops)),
        selectedElementId:
          state.selectedElementId && deleted.has(state.selectedElementId) ? null : state.selectedElementId,
      };
    }),
  );
}
