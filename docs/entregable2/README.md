# Entregable 2 — documento en LaTeX

Fuente del informe del prototipo 2 (`p2_1e.pdf`). Está pensado para Overleaf.

## Abrir en Overleaf

1. Comprimir esta carpeta (`docs/entregable2/`) en un `.zip`, o usar `entregable2-overleaf.zip`
   si ya está generado (no se versiona).
2. En Overleaf: **New Project → Upload Project** y elegir el `.zip`.
3. **Menu → Compiler: pdfLaTeX** · **Main document: `main.tex`**. Overleaf compila dos veces
   automáticamente (índice, referencias y "Página X de Y").

## Estructura

```
main.tex              documento raíz (solo \input de las secciones)
preambulo.tex         tipografía, colores de la marca, recuadros, estilos de diagramas
secciones/
  00-portada.tex      portada
  01-equipo.tex       1. Team
  02-sistema.tex      2. Software System (logo, alcance, requisitos)
  03-cc.tex           3. C&C: vista, catálogo de componentes y conectores, estilos y patrones
  04-despliegue.tex   4. Deployment
  05-capas.tex        5. Layered (sistema y presentación web con SSR)
  06-descomposicion.tex 6. Decomposition
  07-prototipo.tex    7. Prototype (descarga, variables, ejecución, verificación)
  08-trazabilidad.tex 8. Escenarios, pruebas ejecutadas, limitaciones, lenguajes
figuras/              logo (los diagramas son TikZ: vectoriales y editables)
```

## Convenciones para el equipo

- **Lo que falta** está en recuadros amarillos `\begin{pendiente}{Responsable} … \end{pendiente}`.
  Antes de entregar, buscar `pendiente` en el proyecto: no debe quedar ninguno.
- **Estado** en tablas: `\hecho`, `\integracion`, `\porhacer`, `\pone` (del P1).
- **Decisiones** de arquitectura: `\begin{decision}{título} … \end{decision}`.
- **Código en línea**: `\code{texto}` (escapar `_` como `\_`).
- **Tablas**: encabezado con `\encabezado \hd{Columna} & …`, filas alternas con `\filas`.
- Los diagramas están en TikZ dentro de cada sección: para mover un componente basta cambiar
  sus coordenadas `at (x,y)`.

## Compilar localmente (opcional)

Con TeX Live completo:

```bash
latexmk -pdf main.tex
```

O con Docker, sin instalar nada:

```bash
docker run --rm -v "$PWD:/doc" -w /doc texlive/texlive:latest latexmk -pdf -outdir=build main.tex
```

> Nota: el plan del P2 pide el informe en Markdown exportado a PDF. Este documento en LaTeX
> mejora la presentación; si el docente exige el `.md`, el contenido de cada sección se puede
> pasar a `p2_1e.md` sin cambios de fondo.
