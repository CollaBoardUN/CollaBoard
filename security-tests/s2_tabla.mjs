#!/usr/bin/env node
// Genera la tabla «caso -> P2 -> P3» del escenario S2 a partir de CATALOGO (s2_proxy.mjs)
// y de los JSON que produce `s2_proxy.mjs --json` (nunca a mano).
//
//   node security-tests/s2_tabla.mjs [--antes p2.json] [--despues p3.json] [--escribir security-tests/s2_catalogo.md]
//
// Sin --escribir imprime la tabla. Con --escribir reemplaza el bloque entre
// <!-- s2:tabla:inicio --> y <!-- s2:tabla:fin --> del archivo indicado.
import fs from "node:fs";

import { CATALOGO } from "./s2_proxy.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const load = (f) => (f ? JSON.parse(fs.readFileSync(f, "utf8")) : null);
const antes = load(args.antes);
const despues = load(args.despues);

const cell = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
const short = (s, n = 140) => (s && s.length > n ? s.slice(0, n) + "…" : s);
function result(run, id) {
  const r = run?.resultados.find((x) => x.id === id);
  if (!r) return "—";
  const up = r.verif === "log" ? ` · upstream: ${r.upstream}` : "";
  return `**${r.ok ? "OK" : "FAIL"}** ${cell(short(r.detail))}${cell(up)}`;
}
const header = (run, name) => (run ? `${name} (${run.etiqueta || run.objetivo})` : name);

const cols = ["Caso", "Categoría · táctica", "Petición exacta", "Esperado en el P3"];
if (antes) cols.push(header(antes, "Real en el P2"));
if (despues) cols.push(header(despues, "Real en el P3"));
const lines = [`| ${cols.join(" | ")} |`, `|${cols.map(() => "---").join("|")}|`];
for (const c of CATALOGO) {
  const row = [`**${c.id}**`, cell(`${c.cat} · ${c.tactica}`), cell(c.peticion), cell(c.esperado)];
  if (antes) row.push(result(antes, c.id));
  if (despues) row.push(result(despues, c.id));
  lines.push(`| ${row.join(" | ")} |`);
}
const summary = (run, name) => {
  if (!run) return null;
  const s = run.resumen;
  return `- **${name}** (${run.etiqueta || run.objetivo}, ${run.inicio}): ataques bloqueados o normalizados **${s.ataques_ok}/${s.ataques}** · controles ${s.controles_ok}/${s.controles} · rechazos con \`us=-\` en el log ${s.rechazos_us_guion}/${s.rechazos_con_log}.`;
};
const totals = [summary(antes, "P2"), summary(despues, "P3")].filter(Boolean);
const table = [...lines, ...(totals.length ? ["", ...totals] : [])].join("\n");

if (args.escribir) {
  const md = fs.readFileSync(args.escribir, "utf8");
  const start = "<!-- s2:tabla:inicio -->";
  const end = "<!-- s2:tabla:fin -->";
  const i = md.indexOf(start);
  const j = md.indexOf(end);
  if (i < 0 || j < i) throw new Error(`faltan los marcadores ${start} / ${end} en ${args.escribir}`);
  const note = `<!-- Generado por: node security-tests/s2_tabla.mjs${args.antes ? ` --antes ${args.antes}` : ""}${args.despues ? ` --despues ${args.despues}` : ""}. No editar a mano. -->`;
  fs.writeFileSync(args.escribir, `${md.slice(0, i + start.length)}\n${note}\n\n${table}\n\n${md.slice(j)}`);
  console.log(`Tabla escrita en ${args.escribir}`);
} else {
  console.log(table);
}
