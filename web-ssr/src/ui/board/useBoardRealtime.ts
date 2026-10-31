"use client";

/**
 * Conecta un tablero con Pizarra en tiempo real.
 *
 *     useBoardRealtime(boardId, { initialElements, savedAt, seq });
 *
 * - Cambios locales en `useBoardStore` -> se envían como operaciones.
 * - Operaciones remotas -> se aplican al store (y por tanto al canvas).
 * - Cursor propio y trazo en curso -> se envían (con límite de frecuencia).
 * - Cursores, trazos en curso, presencia y guardado -> `useRealtime`.
 *
 * El socket lo abre el transporte de la presentación (web: cookie de sesión en
 * el mismo origen; Electron: proceso principal), nunca con el token en la URL.
 */
import { useEffect } from "react";

import type { CanvasElement } from "@/core/domain/canvas";
import { applyRemoteOps, isApplyingRemote, reconcileBoardElements, replaceBoardElements } from "@/core/realtime/boardBridge";
import { diffElements } from "@/core/realtime/elementOps";
import { RealtimeClient } from "@/core/realtime/RealtimeClient";
import { useRealtime } from "@/core/realtime/realtimeStore";
import { useBoardStore } from "@/core/stores/useBoardStore";
import { toast } from "@/core/stores/toastStore";
import { useTransport } from "../AppContext";

const CURSOR_EVERY_MS = 40;
const DRAFT_EVERY_MS = 50;

export interface InitialCanvas {
  /** Estado guardado que se renderizó en el servidor (se reemplaza con el `sync`). */
  elements?: CanvasElement[];
  savedAt?: string | null;
  seq?: number | null;
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

export function useBoardRealtime(boardId: string, initial: InitialCanvas = {}): void {
  const transport = useTransport();
  const { elements: initialElements, savedAt, seq } = initial;

  useEffect(() => {
    if (!boardId) return;

    useRealtime.getState().reset();
    useRealtime.getState().seedSave(savedAt ?? null, seq ?? null);
    // Se muestra lo guardado (renderizado en el servidor) mientras llega el `sync`
    // del servidor; nunca el tablero anterior.
    replaceBoardElements(initialElements ?? []);

    let warnedReadOnly = false;
    const client = new RealtimeClient({
      connect: () => transport.openSocket(`/ws/boards/${encodeURIComponent(boardId)}`),
      handlers: {
        onStatus: (status) => useRealtime.getState().setStatus(status),
        onSync: (message) => {
          const state = useRealtime.getState();
          state.setSelfConn(message.you.conn);
          state.setPeers(message.peers);
          replaceBoardElements(message.elements);
        },
        onOps: (message) => {
          if (message.conn !== useRealtime.getState().selfConn) applyRemoteOps(message.ops);
          // Si el trazo en curso de ese usuario ya quedó confirmado, quitamos su "fantasma".
          const state = useRealtime.getState();
          const draft = state.drafts[message.conn];
          const committed = message.ops.some((op) => op.op === "add" && op.element.id === draft?.id);
          if (committed) state.setDraft(message.conn, null);
        },
        onReconcile: reconcileBoardElements,
        onPresence: (peers) => useRealtime.getState().setPeers(peers),
        onCursor: (conn, x, y) => useRealtime.getState().setCursor(conn, { x, y }),
        onDraft: (conn, element) => useRealtime.getState().setDraft(conn, element),
        onForbidden: () => {
          if (warnedReadOnly) return;
          warnedReadOnly = true;
          toast.error("Solo tienes permiso para mirar este tablero");
        },
        onSaved: (savedSeq, at) => useRealtime.getState().setSaved(savedSeq, at),
        onSaveError: () => useRealtime.getState().setSaveError(),
        onRestored: (by) => toast.ok(by ? `${by} restauró una versión del tablero` : "Se restauró una versión"),
      },
    });

    // Local -> red: cualquier cambio de elementos que no venga de la red (dibujar,
    // mover, borrar, deshacer, limpiar…) se traduce en operaciones.
    const unsubscribeBoard = useBoardStore.subscribe((state, previous) => {
      if (state.elements === previous.elements || isApplyingRemote()) return;
      client.sendOps(diffElements(previous.elements, state.elements));
    });

    const sendDraft = throttle((element: CanvasElement | null) => client.sendDraft(element), DRAFT_EVERY_MS);
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
    // El estado inicial solo siembra la primera conexión; no debe reconectar si cambia.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardId, transport]);
}
