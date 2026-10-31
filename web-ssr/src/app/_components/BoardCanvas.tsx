"use client";

/**
 * Konva necesita `window` y un `<canvas>` real: el lienzo se carga solo en el
 * navegador. El servidor entrega mientras tanto un marcador accesible.
 */
import dynamic from "next/dynamic";

const CanvasBoard = dynamic(() => import("@/ui/canvas/CanvasBoard").then((m) => m.CanvasBoard), {
  ssr: false,
  loading: () => (
    <div className="canvas-loading" role="status">
      Preparando el lienzo…
    </div>
  ),
});

export function BoardCanvas({ authorId, readOnly }: { authorId: string; readOnly: boolean }) {
  return <CanvasBoard authorId={authorId} readOnly={readOnly} />;
}
