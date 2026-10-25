"use client";

import { useEffect, useState } from "react";

import { APP_TIME_ZONE, relativeTime } from "@/core/lib/format";
import { useRealtime } from "@/core/realtime/realtimeStore";

/** "Guardado hace 2 minutos": lo confirma Pizarra con el mensaje `saved` del autosave. */
export function SaveIndicator() {
  const save = useRealtime((s) => s.save);
  const [, tick] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(timer);
  }, []);

  if (save.status === "error") {
    return (
      <span className="save-indicator save-error" role="status">
        No se pudo guardar · reintentando
      </span>
    );
  }
  if (!save.savedAt) return null;
  return (
    <span className="save-indicator" role="status" title={new Date(save.savedAt).toLocaleString("es-CO", { timeZone: APP_TIME_ZONE })}
      suppressHydrationWarning
    >
      Guardado {relativeTime(save.savedAt)}
    </span>
  );
}
