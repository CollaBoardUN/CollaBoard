/**
 * Conecta un tablero con el servidor en tiempo real.
 *
 *     useBoardRealtime(boardId);   // una sola llamada en la página del tablero
 *
 * - Cambios locales en `useBoardStore` -> se envían como operaciones.
 * - Operaciones remotas -> se aplican al store (y por tanto al canvas).
 * - Cursor propio y trazo en curso -> se envían (con límite de frecuencia).
 * - Cursores, trazos en curso y presencia ajenos -> `useRealtime`.
 */
import { useEffect } from "react";

import { useAuth } from "../auth/authStore";
import { toast } from "../components/toastStore";
import type { CanvasElement } from "../domain/models/canvas";
import { API_URL } from "../lib/api";
import { useBoardStore } from "../store/useBoardStore";
import { applyRemoteOps, isApplyingRemote, replaceBoardElements } from "./boardBridge";
import { diffElements } from "./elementOps";
import { RealtimeClient } from "./RealtimeClient";
import { useRealtime } from "./realtimeStore";

const CURSOR_EVERY_MS = 40;
const DRAFT_EVERY_MS = 50;

export function realtimeUrl(boardId: string, token: string | null): string | null {
  if (!token) return null;
  const base = API_URL.replace(/^http/, "ws");
  return `${base}/ws/boards/${encodeURIComponent(boardId)}?token=${encodeURIComponent(token)}`;
}

/** Ejecuta `fn` como máximo cada `ms`, garantizando que la última llamada no se pierda. */
function throttle<Args extends unknown[]>(fn: (...args: Args) => void, ms: number) {
  let last = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Args | undefined;

  const run = (args: Args) => {
    last = Date.now();
    pending = undefined;
    fn(...args);
  };
  const throttled = (...args: Args) => {
    const wait = ms - (Date.now() - last);
    if (wait <= 0) {
      clearTimeout(timer);
      timer = undefined;
      run(args);
      return;
    }
    pending = args;
    timer ??= setTimeout(() => {
      timer = undefined;
      if (pending) run(pending);
    }, wait);
  };
  throttled.cancel = () => {
    clearTimeout(timer);
    timer = undefined;
    pending = undefined;
  };
  return throttled;
}

export function useBoardRealtime(boardId: string): void {
  useEffect(() => {
    if (!boardId) return;

    useRealtime.getState().reset();
    // Evita ver un instante el tablero anterior mientras llega el estado del servidor.
    replaceBoardElements([]);

    let warnedReadOnly = false;
    const client = new RealtimeClient({
      url: () => realtimeUrl(boardId, useAuth.getState().token),
      handlers: {
        onStatus: (status) => useRealtime.getState().setStatus(status),
        onSync: (message) => {
          const state = useRealtime.getState();
          state.setSelfConn(message.you.conn);
          state.setPeers(message.peers);
          replaceBoardElements(message.elements);
        },
        onOps: (message) => {
          applyRemoteOps(message.ops);
          // Si el trazo en curso de ese usuario ya quedó confirmado, quitamos su "fantasma".
          const state = useRealtime.getState();
          const draft = state.drafts[message.conn];
          const committed = message.ops.some((op) => op.op === "add" && op.element.id === draft?.id);
          if (committed) state.setDraft(message.conn, null);
        },
        onPresence: (peers) => useRealtime.getState().setPeers(peers),
        onCursor: (conn, x, y) => useRealtime.getState().setCursor(conn, { x, y }),
        onDraft: (conn, element) => useRealtime.getState().setDraft(conn, element),
        onForbidden: () => {
          if (warnedReadOnly) return;
          warnedReadOnly = true;
          toast.error("Solo tienes permiso para mirar este tablero");
        },
      },
    });

    // Local -> red: cualquier cambio de elementos que no venga de la red (dibujar,
    // mover, borrar, deshacer, limpiar…) se traduce en operaciones.
    const unsubscribeBoard = useBoardStore.subscribe((state, previous) => {
      if (state.elements === previous.elements || isApplyingRemote()) return;
      client.sendOps(diffElements(previous.elements, state.elements));
    });

    const sendDraft = throttle(
      (element: CanvasElement | null) => client.sendDraft(element),
      DRAFT_EVERY_MS,
    );
    const unsubscribeDraft = useRealtime.subscribe((state, previous) => {
      if (state.localDraft === previous.localDraft) return;
      if (state.localDraft) {
        sendDraft(state.localDraft);
      } else {
        sendDraft.cancel();
        client.sendDraft(null);
      }
    });

    const sendCursor = throttle((x: number, y: number) => client.sendCursor(x, y), CURSOR_EVERY_MS);
    const onPointerMove = (event: PointerEvent) => sendCursor(event.clientX, event.clientY);
    window.addEventListener("pointermove", onPointerMove);

    client.connect();

    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      sendCursor.cancel();
      sendDraft.cancel();
      unsubscribeDraft();
      unsubscribeBoard();
      client.close();
      useRealtime.getState().reset();
    };
  }, [boardId]);
}
