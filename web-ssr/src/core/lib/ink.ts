// Colores de marcador: el mismo id siempre recibe el mismo color.
const INKS = ["#2457c5", "#1e8a5a", "#c8372d", "#7a4fc4", "#b8650a", "#0f7f8c"];

export function inkFor(id: string): string {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return INKS[h % INKS.length];
}

/** Garabato determinista para la tarjeta de un tablero sin miniatura. */
export function doodleFor(seed: string) {
  let s = 0;
  for (const ch of seed) s = (s * 33 + ch.charCodeAt(0)) >>> 0;
  const rand = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
  // Arriba de la mitad, para no cruzar el nombre escrito abajo.
  const y0 = 34 + rand() * 18;
  let d = `M ${14 + rand() * 10} ${y0}`;
  for (let x = 40; x <= 220; x += 30) {
    d += ` Q ${x - 15} ${y0 + (rand() - 0.5) * 34}, ${x} ${y0 + (rand() - 0.5) * 20}`;
  }
  return {
    path: d,
    color: inkFor(seed),
    cx: 170 + rand() * 45,
    cy: 26 + rand() * 10,
    rx: 14 + rand() * 10,
    ry: 10 + rand() * 6,
  };
}
