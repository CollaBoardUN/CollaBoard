#!/usr/bin/env python3
"""Generador de las vistas draw.io (.drawio) para el Escenario S5 · RBAC Authorizer.

Usa como base las vistas redibujadas en draw.io por Jhon (S1) y produce archivos .drawio
con diseño espaciado y cero solapamientos de texto ni de cajas:
  1. docs/p3/diagramas/base/vista-descomposicion.base.drawio  (entrega de línea base de David)
  2. docs/p3/diagramas/base/vista-cc.base.drawio              (copia de la base oficial de C&C)
  3. docs/p3/diagramas/vista-cc.S5.drawio                     (color rojo #D62828 para S5)
  4. docs/p3/diagramas/vista-despliegue.S5.drawio             (color rojo #D62828 para S5)
  5. docs/p3/diagramas/vista-capas.S5.drawio                  (color rojo #D62828 para S5)
  6. docs/p3/diagramas/vista-descomposicion.S5.drawio         (color rojo #D62828 para S5)
  7. docs/p3/diagramas/secuencia-s5.drawio                    (diagrama de secuencia Antes vs Después)
"""

from __future__ import annotations

import pathlib
import xml.etree.ElementTree as ET

RED_STROKE = "#D62828"
RED_FILL = "#FDECEC"


def add_vertex(
    root_el: ET.Element,
    cell_id: str,
    value: str,
    style: str,
    x: float,
    y: float,
    w: float,
    h: float,
) -> None:
    cell = ET.SubElement(
        root_el,
        "mxCell",
        {"id": cell_id, "value": value, "style": style, "vertex": "1", "parent": "1"},
    )
    ET.SubElement(
        cell,
        "mxGeometry",
        {"x": str(int(x)), "y": str(int(y)), "width": str(int(w)), "height": str(int(h)), "as": "geometry"},
    )


def add_edge(
    root_el: ET.Element,
    cell_id: str,
    style: str,
    sx: float,
    sy: float,
    tx: float,
    ty: float,
    waypoints: list[tuple[float, float]] | None = None,
) -> None:
    cell = ET.SubElement(
        root_el,
        "mxCell",
        {"id": cell_id, "value": "", "style": style, "edge": "1", "parent": "1"},
    )
    geom = ET.SubElement(cell, "mxGeometry", {"relative": "1", "as": "geometry"})
    ET.SubElement(geom, "mxPoint", {"x": str(int(sx)), "y": str(int(sy)), "as": "sourcePoint"})
    ET.SubElement(geom, "mxPoint", {"x": str(int(tx)), "y": str(int(ty)), "as": "targetPoint"})
    if waypoints:
        arr = ET.SubElement(geom, "Array", {"as": "points"})
        for wx, wy in waypoints:
            ET.SubElement(arr, "mxPoint", {"x": str(int(wx)), "y": str(int(wy))})


def build_all_diagrams(s1_diag_dir: pathlib.Path, out_diag_dir: pathlib.Path) -> None:
    base_dir = out_diag_dir / "base"
    base_dir.mkdir(parents=True, exist_ok=True)

    red_box_style = (
        f"rounded=1;html=1;whiteSpace=wrap;fillColor={RED_FILL};strokeColor={RED_STROKE};"
        f"fontColor={RED_STROKE};fontFamily=Helvetica;fontSize=9;align=center;verticalAlign=middle;strokeWidth=1.5;"
    )

    # ------------------------------------------------------------------
    # 0. Copiar base C&C y crear base de Descomposición (entrega base de David)
    # ------------------------------------------------------------------
    cc_base_src = s1_diag_dir / "base" / "vista-cc.base.drawio"
    cc_base_dst = base_dir / "vista-cc.base.drawio"
    cc_base_dst.write_text(cc_base_src.read_text(encoding="utf-8"), encoding="utf-8")

    decomp_s1_tree = ET.parse(s1_diag_dir / "vista-descomposicion.S1.drawio")
    decomp_base_root = decomp_s1_tree.getroot()
    diag_el = decomp_base_root.find("diagram")
    if diag_el is not None:
        diag_el.attrib["id"] = "vista-descomposicion-base"
        diag_el.attrib["name"] = "Descomposición base (P2)"
    graph_root = decomp_base_root.find(".//root")
    assert graph_root is not None
    for cid in ("descomposicion-s1-30", "descomposicion-s1-31", "descomposicion-s1-90"):
        el = graph_root.find(f"mxCell[@id='{cid}']")
        if el is not None:
            graph_root.remove(el)
    decomp_base_path = base_dir / "vista-descomposicion.base.drawio"
    decomp_s1_tree.write(decomp_base_path, encoding="utf-8")

    # ------------------------------------------------------------------
    # 1. Vista C&C · S5 (sobre base/vista-cc.base.drawio, sin solapamientos)
    # ------------------------------------------------------------------
    cc_tree = ET.parse(cc_base_dst)
    cc_diag = cc_tree.find("diagram")
    if cc_diag is not None:
        cc_diag.attrib["id"] = "vista-cc-s5"
        cc_diag.attrib["name"] = "C&C · S5 RBAC Authorizer"
    cc_root = cc_tree.find(".//root")
    assert cc_root is not None

    # Quitar el antiguo conector cc-66..cc-69 (REST entre collaboration y chat)
    for cid in ("cc-66", "cc-67", "cc-68", "cc-69"):
        el = cc_root.find(f"mxCell[@id='{cid}']")
        if el is not None:
            cc_root.remove(el)

    # Anotación PEP + Caché para pizarra-api colocada en la franja libre superior (x=725, y=110)
    # No toca a auth-api (x=970,y=40..100) ni la etiqueta "REST + WebSocket" (x=850,y=163)
    add_vertex(
        cc_root,
        "cc-s5-pep-piz",
        "«PEP + Cache-Aside»<br><b>Caché decisiones (TTL 2 s)</b><br>fail-closed · recheck WS ≤ 5 s",
        red_box_style,
        720,
        104,
        210,
        52,
    )
    add_edge(
        cc_root,
        "cc-s5-pep-piz-link",
        f"endArrow=none;html=1;dashed=1;strokeColor={RED_STROKE};strokeWidth=1.5;",
        930,
        130,
        970,
        165,
    )

    # Anotación PDP para collaboration-api colocada en la franja libre (x=720, y=346)
    # Debajo de la línea gateway->collaboration (y=311) y encima de la línea gateway->chat (y=451)
    add_vertex(
        cc_root,
        "cc-s5-pdp",
        "«PDP · Authorizer»<br><b>Política única RBAC (policy.py)</b><br>/internal/boards/{id}/access?action=",
        red_box_style,
        710,
        344,
        225,
        54,
    )
    add_edge(
        cc_root,
        "cc-s5-pdp-link",
        f"endArrow=none;html=1;dashed=1;strokeColor={RED_STROKE};strokeWidth=1.5;",
        935,
        365,
        970,
        330,
    )

    # Anotación PEP + Caché para chat-api colocada debajo de chat-api (x=945, y=496..548)
    # Encima de pixels-api (y=580), sin tocar ningún otro texto
    add_vertex(
        cc_root,
        "cc-s5-pep-chat",
        "«PEP + Cache-Aside»<br><b>Caché decisiones (TTL 2 s)</b><br>X-Service-Token · recheck WS 3 s",
        red_box_style,
        945,
        496,
        200,
        50,
    )
    add_edge(
        cc_root,
        "cc-s5-pep-chat-link",
        f"endArrow=none;html=1;dashed=1;strokeColor={RED_STROKE};strokeWidth=1.5;",
        1045,
        480,
        1045,
        496,
    )

    # Conector rojo vertical: pizarra-api (y=220) -> collaboration-api (y=280)
    add_edge(
        cc_root,
        "cc-s5-edge-piz-pdp",
        f"endArrow=classic;html=1;rounded=0;strokeColor={RED_STROKE};strokeWidth=2;",
        1045,
        220,
        1045,
        280,
    )
    add_vertex(
        cc_root,
        "cc-s5-lbl-piz-pdp",
        "HTTP :8000 · <b>authorize(role, action)</b><br>X-Service-Token + Bearer JWT",
        f"text;html=1;align=left;verticalAlign=middle;whiteSpace=wrap;fontFamily=Helvetica;fontSize=9;fontColor={RED_STROKE};",
        1055,
        233,
        210,
        34,
    )

    # Conector rojo vertical: chat-api (y=420) -> collaboration-api (y=340)
    add_edge(
        cc_root,
        "cc-s5-edge-chat-pdp",
        f"endArrow=classic;html=1;rounded=0;strokeColor={RED_STROKE};strokeWidth=2;",
        1045,
        420,
        1045,
        340,
    )
    add_vertex(
        cc_root,
        "cc-s5-lbl-chat-pdp",
        "HTTP :8000 · <b>authorize(role, action)</b><br>/internal/boards/{id}/access + recipients",
        f"text;html=1;align=left;verticalAlign=middle;whiteSpace=wrap;fontFamily=Helvetica;fontSize=9;fontColor={RED_STROKE};",
        1055,
        355,
        215,
        34,
    )

    # Leyenda S5 con ancho suficiente (380x135) para que ninguna línea desborde
    add_vertex(
        cc_root,
        "cc-s5-legend",
        (
            "<b>Leyenda</b><br>negro: línea base P2<br>"
            f"<font color='{RED_STROKE}'><b>rojo: S5 · RBAC + Authorizer (PDP / PEP)</b></font><br>"
            "• PDP único en collaboration-api (POLICY_MATRIX)<br>"
            "• PEPs con Cache-Aside (TTL 2 s) en pizarra-api y chat-api<br>"
            "• Revocación efectiva en WS ≤ 5 s · Falla cerrada (fail-closed)"
        ),
        "rounded=0;html=1;whiteSpace=wrap;fillColor=#FFFFFF;strokeColor=#000000;align=left;verticalAlign=top;spacing=8;fontFamily=Helvetica;fontSize=10;",
        20,
        40,
        380,
        135,
    )
    cc_tree.write(out_diag_dir / "vista-cc.S5.drawio", encoding="utf-8")

    # ------------------------------------------------------------------
    # 2. Vista de Despliegue · S5 (sin solapamientos)
    # ------------------------------------------------------------------
    dep_tree = ET.parse(s1_diag_dir / "vista-despliegue.S1.drawio")
    dep_diag = dep_tree.find("diagram")
    if dep_diag is not None:
        dep_diag.attrib["id"] = "despliegue-s5"
        dep_diag.attrib["name"] = "Despliegue · S5 RBAC Authorizer"
    dep_root = dep_tree.find(".//root")
    assert dep_root is not None

    for cid in (
        "despliegue-s1-18",
        "despliegue-s1-19",
        "despliegue-s1-20",
        "despliegue-s1-21",
        "despliegue-s1-22",
        "despliegue-s1-113",
        "despliegue-s1-114",
        "despliegue-s1-115",
        "despliegue-s1-116",
        "despliegue-s1-117",
    ):
        el = dep_root.find(f"mxCell[@id='{cid}']")
        if el is not None:
            dep_root.remove(el)
    add_vertex(
        dep_root,
        "despliegue-base-80",
        "80",
        "text;html=1;align=center;verticalAlign=middle;fontFamily=Helvetica;fontSize=10;",
        222,
        268,
        40,
        16,
    )
    # Cajas rojas en el corredor libre entre la columna izquierda de contenedores (x=310..475)
    # y la columna derecha de bases/brokers (x=600..765): ubicadas en x=480, width=116
    add_vertex(
        dep_root,
        "despliegue-s5-pdp",
        "«PDP · Authorizer»<br><b>POLICY_MATRIX</b><br>DECISION_TTL=2s<br>X-Service-Token",
        red_box_style,
        480,
        462,
        116,
        66,
    )
    add_vertex(
        dep_root,
        "despliegue-s5-pep-piz",
        "«PEP + Cache-Aside»<br><b>Caché en proceso</b><br>CACHE_TTL=2s<br>ROLE_RECHECK=2s",
        red_box_style,
        480,
        562,
        116,
        66,
    )
    add_vertex(
        dep_root,
        "despliegue-s5-pep-chat",
        "«PEP + Cache-Aside»<br><b>Caché en proceso</b><br>CACHE_TTL=2000ms<br>RECHECK=3000ms",
        red_box_style,
        480,
        662,
        116,
        66,
    )
    add_vertex(
        dep_root,
        "despliegue-s5-legend",
        (
            "<b>Leyenda</b><br>negro: P2 · <font color='#6B7280'>gris: corrección compose</font><br>"
            f"<font color='{RED_STROKE}'><b>rojo: S5 · RBAC Authorizer</b></font><br><br>"
            "<b>Sin contenedor adicional:</b> la caché Cache-Aside vive en la memoria de cada "
            "proceso PEP (pizarra-api y chat-api) con TTL=2 s, y collaboration-api evalúa "
            "POLICY_MATRIX contra board-db (uq_board_user)."
        ),
        "rounded=0;html=1;whiteSpace=wrap;fillColor=#FFFFFF;strokeColor=#000000;align=left;verticalAlign=top;spacing=6;fontFamily=Helvetica;fontSize=10;",
        935,
        895,
        215,
        240,
    )
    dep_tree.write(out_diag_dir / "vista-despliegue.S5.drawio", encoding="utf-8")

    # ------------------------------------------------------------------
    # 3. Vista de Capas · S5 (ampliando Logic Tier para que nada se pise)
    # ------------------------------------------------------------------
    cap_tree = ET.parse(s1_diag_dir / "vista-capas.S1.drawio")
    cap_diag = cap_tree.find("diagram")
    if cap_diag is not None:
        cap_diag.attrib["id"] = "capas-s5"
        cap_diag.attrib["name"] = "Capas · S5 RBAC Authorizer"
    cap_model = cap_tree.find(".//mxGraphModel")
    if cap_model is not None:
        cap_model.attrib["pageWidth"] = "1320"
        cap_model.attrib["pageHeight"] = "930"
    cap_root = cap_tree.find(".//root")
    assert cap_root is not None

    for cid in ("capas-s1-32", "capas-s1-33", "capas-s1-34"):
        el = cap_root.find(f"mxCell[@id='{cid}']")
        if el is not None:
            cap_root.remove(el)
    el10 = cap_root.find("mxCell[@id='capas-s1-10']")
    if el10 is not None:
        el10.attrib["value"] = "Allow to use"

    # Ampliar la altura de Logic Tier (capas-s1-5) de 220 -> 270 px
    # y bajar la segunda fila de Logic Tier (pixels-api, notification-api, message-worker) +45 px
    # y bajar Data/Messaging Tier +50 px para dejar espacio amplio a las etiquetas rojas PDP/PEP.
    logic_geom = cap_root.find("mxCell[@id='capas-s1-5']/mxGeometry")
    if logic_geom is not None:
        logic_geom.attrib["height"] = "270"

    for cid in ("capas-s1-22", "capas-s1-23", "capas-s1-24"):
        g = cap_root.find(f"mxCell[@id='{cid}']/mxGeometry")
        if g is not None:
            g.attrib["y"] = str(int(float(g.attrib["y"]) + 50))

    for cid in (
        "capas-s1-7",
        "capas-s1-8",
        "capas-s1-14",
        "capas-s1-25",
        "capas-s1-26",
        "capas-s1-27",
        "capas-s1-28",
        "capas-s1-29",
        "capas-s1-30",
        "capas-s1-31",
    ):
        g = cap_root.find(f"mxCell[@id='{cid}']/mxGeometry")
        if g is not None:
            g.attrib["y"] = str(int(float(g.attrib["y"]) + 50))

    edge13_geom = cap_root.find("mxCell[@id='capas-s1-13']/mxGeometry")
    if edge13_geom is not None:
        for pt in edge13_geom.findall("mxPoint"):
            pt.attrib["y"] = str(int(float(pt.attrib["y"]) + 50))

    # Ahora entre la fila 1 de Logic Tier (y=440..490) y la fila 2 (y=580..630) hay 90 px libres (y=490..580)
    add_vertex(
        cap_root,
        "capas-s5-pdp",
        "«PDP · Authorizer»<br><b>Política RBAC única (policy.py)</b>",
        red_box_style,
        285,
        502,
        190,
        40,
    )
    add_vertex(
        cap_root,
        "capas-s5-pep-piz",
        "«PEP + Cache-Aside»<br><b>Caché decisiones (TTL 2 s)</b>",
        red_box_style,
        515,
        502,
        190,
        40,
    )
    add_vertex(
        cap_root,
        "capas-s5-pep-chat",
        "«PEP + Cache-Aside»<br><b>Caché decisiones (TTL 2 s)</b>",
        red_box_style,
        745,
        502,
        190,
        40,
    )
    add_edge(
        cap_root,
        "capas-s5-e1",
        f"endArrow=classic;html=1;rounded=0;strokeColor={RED_STROKE};strokeWidth=1.8;",
        520,
        465,
        470,
        465,
    )
    add_edge(
        cap_root,
        "capas-s5-e2",
        f"endArrow=classic;html=1;rounded=0;strokeColor={RED_STROKE};strokeWidth=1.8;",
        750,
        440,
        470,
        440,
        waypoints=[(750, 424), (470, 424)],
    )
    add_vertex(
        cap_root,
        "capas-s5-lbl",
        "authorize(role, action) · GET /internal/boards/{id}/access",
        f"text;html=1;align=center;verticalAlign=middle;whiteSpace=wrap;fontSize=9;fontColor={RED_STROKE};",
        470,
        403,
        300,
        18,
    )
    add_vertex(
        cap_root,
        "capas-s5-legend",
        (
            "<b>Leyenda</b><br>negro: P2<br>"
            f"<font color='{RED_STROKE}'><b>rojo: S5 · RBAC + Authorizer</b></font><br><br>"
            "En <b>Logic Tier</b>:<br>"
            "• <b>collaboration-api</b> actúa como único <b>PDP</b> (Policy Decision Point).<br>"
            "• <b>pizarra-api</b> y <b>chat-api</b> actúan como <b>PEPs</b> con caché de decisiones (TTL 2 s).<br>"
            "• El gateway (Communication Tier) no decodifica JWT ni decide permisos de negocio."
        ),
        "rounded=0;html=1;whiteSpace=wrap;fillColor=#FFFFFF;strokeColor=#000000;align=left;verticalAlign=top;spacing=8;fontFamily=Helvetica;fontSize=10;",
        1020,
        390,
        280,
        210,
    )
    cap_tree.write(out_diag_dir / "vista-capas.S5.drawio", encoding="utf-8")

    # ------------------------------------------------------------------
    # 4. Vista de Descomposición · S5 (cajas más anchas/altas y sin desborde)
    # ------------------------------------------------------------------
    dec_tree = ET.parse(decomp_base_path)
    dec_diag = dec_tree.find("diagram")
    if dec_diag is not None:
        dec_diag.attrib["id"] = "descomposicion-s5"
        dec_diag.attrib["name"] = "Descomposición · S5 RBAC Authorizer"
    dec_model = dec_tree.find(".//mxGraphModel")
    if dec_model is not None:
        dec_model.attrib["pageHeight"] = "690"
    dec_root = dec_tree.find(".//root")
    assert dec_root is not None

    # En collaboration-api: "Política RBAC (PDP)" con ancho 155 y alto 44
    add_vertex(
        dec_root,
        "descomposicion-s5-pdp",
        "<b>Política RBAC (PDP)</b><br>app/policy.py · /internal/policy",
        red_box_style,
        700,
        322,
        155,
        44,
    )
    add_edge(
        dec_root,
        "descomposicion-s5-pdp-e",
        f"endArrow=classic;html=1;rounded=0;strokeColor={RED_STROKE};endSize=5;",
        685,
        250,
        700,
        344,
        waypoints=[(685, 344)],
    )

    # Desplazar pizarra-api +55 px hacia abajo para dejar margen limpio bajo la caja roja de collaboration-api
    for cid, dy in (
        ("descomposicion-s1-46", 55),
        ("descomposicion-s1-48", 55),
        ("descomposicion-s1-50", 55),
    ):
        el = dec_root.find(f"mxCell[@id='{cid}']/mxGeometry")
        if el is not None:
            el.attrib["y"] = str(int(float(el.attrib["y"]) + dy))
    for cid, dy in (
        ("descomposicion-s1-47", 55),
        ("descomposicion-s1-49", 55),
        ("descomposicion-s1-51", 55),
    ):
        geom = dec_root.find(f"mxCell[@id='{cid}']/mxGeometry")
        if geom is not None:
            for pt in geom.findall(".//mxPoint"):
                if "y" in pt.attrib and pt.attrib.get("as") != "sourcePoint":
                    pt.attrib["y"] = str(int(float(pt.attrib["y"]) + dy))
            src = geom.find("mxPoint[@as='sourcePoint']")
            if src is not None and cid != "descomposicion-s1-47":
                src.attrib["y"] = str(int(float(src.attrib["y"]) + dy))

    # En pizarra-api: "Caché de decisiones (PEP)" con ancho 155 y alto 44
    add_vertex(
        dec_root,
        "descomposicion-s5-pep-piz",
        "<b>Caché de decisiones (PEP)</b><br>internal_client.py · ws.py",
        red_box_style,
        700,
        530,
        155,
        44,
    )
    add_edge(
        dec_root,
        "descomposicion-s5-pep-piz-e",
        f"endArrow=classic;html=1;rounded=0;strokeColor={RED_STROKE};endSize=5;",
        685,
        425,
        700,
        552,
        waypoints=[(685, 552)],
    )

    # Desplazar notification-api y message-worker +55 px hacia abajo en la columna Comunicación
    for cid, dy in (
        ("descomposicion-s1-58", 55),
        ("descomposicion-s1-60", 55),
        ("descomposicion-s1-62", 55),
        ("descomposicion-s1-64", 55),
    ):
        el = dec_root.find(f"mxCell[@id='{cid}']/mxGeometry")
        if el is not None:
            el.attrib["y"] = str(int(float(el.attrib["y"]) + dy))
    for cid, dy in (
        ("descomposicion-s1-59", 55),
        ("descomposicion-s1-61", 55),
        ("descomposicion-s1-63", 55),
        ("descomposicion-s1-65", 55),
    ):
        geom = dec_root.find(f"mxCell[@id='{cid}']/mxGeometry")
        if geom is not None:
            for pt in geom.findall(".//mxPoint"):
                if "y" in pt.attrib and pt.attrib.get("as") != "sourcePoint":
                    pt.attrib["y"] = str(int(float(pt.attrib["y"]) + dy))
            src = geom.find("mxPoint[@as='sourcePoint']")
            if src is not None and cid not in ("descomposicion-s1-59", "descomposicion-s1-63"):
                src.attrib["y"] = str(int(float(src.attrib["y"]) + dy))

    add_vertex(
        dec_root,
        "descomposicion-s5-pep-chat",
        "<b>Caché de decisiones (PEP)</b><br>CollaborationClient · InternalChat",
        red_box_style,
        910,
        322,
        160,
        44,
    )
    add_edge(
        dec_root,
        "descomposicion-s5-pep-chat-e",
        f"endArrow=classic;html=1;rounded=0;strokeColor={RED_STROKE};endSize=5;",
        895,
        220,
        910,
        344,
        waypoints=[(895, 344)],
    )

    add_vertex(
        dec_root,
        "descomposicion-s5-legend",
        (
            "<b>Leyenda</b><br>negro: P2<br>"
            f"<font color='{RED_STROKE}'><b>rojo: S5 · RBAC + Authorizer (PDP / PEP)</b></font><br>"
            "• collaboration-api → Permisos → Política RBAC (PDP)<br>"
            "• pizarra-api → Caché de decisiones (PEP)<br>"
            "• chat-api → Caché de decisiones (PEP)"
        ),
        "rounded=0;html=1;whiteSpace=wrap;fillColor=#FFFFFF;strokeColor=#000000;align=left;verticalAlign=top;spacing=8;fontFamily=Helvetica;fontSize=10;",
        10,
        450,
        335,
        120,
    )
    dec_tree.write(out_diag_dir / "vista-descomposicion.S5.drawio", encoding="utf-8")

    # ------------------------------------------------------------------
    # 5. Diagrama de secuencia del Escenario S5 (con fondo blanco en etiquetas)
    # ------------------------------------------------------------------
    seq_mx = ET.Element("mxfile", {"host": "app.diagrams.net", "type": "device"})
    seq_diag = ET.SubElement(
        seq_mx, "diagram", {"id": "secuencia-s5", "name": "Secuencia · S5 RBAC Authorizer"}
    )
    seq_model = ET.SubElement(
        seq_diag,
        "mxGraphModel",
        {
            "dx": "1420",
            "dy": "820",
            "grid": "1",
            "gridSize": "10",
            "page": "1",
            "pageScale": "1",
            "pageWidth": "1420",
            "pageHeight": "800",
        },
    )
    seq_root = ET.SubElement(seq_model, "root")
    ET.SubElement(seq_root, "mxCell", {"id": "0"})
    ET.SubElement(seq_root, "mxCell", {"id": "1", "parent": "0"})

    participants = [
        ("p-viewer", "Cliente (Viewer / Editor)<br>WS abierto", 30, 175),
        ("p-owner", "Cliente (Owner)<br>Administración", 245, 165),
        ("p-gw", "gateway<br>(Nginx)", 450, 150),
        ("p-pep", "pizarra-api / chat-api<br>«PEP + Cache-Aside»", 650, 185),
        ("p-pdp", "collaboration-api<br>«PDP · POLICY_MATRIX»", 910, 185),
        ("p-db", "board-db<br>(PostgreSQL)", 1180, 150),
    ]
    for pid, label, px, pw in participants:
        style = (
            red_box_style
            if pid in ("p-pep", "p-pdp")
            else "rounded=1;whiteSpace=wrap;html=1;fillColor=#F5F5F5;strokeColor=#000000;fontSize=10;fontStyle=1;align=center;verticalAlign=middle;"
        )
        add_vertex(seq_root, pid, label, style, px, 20, pw, 50)
        lx = px + pw / 2
        add_edge(
            seq_root,
            f"{pid}-line",
            "endArrow=none;html=1;dashed=1;strokeColor=#9CA3AF;",
            lx,
            70,
            lx,
            760,
        )

    # Centros de las líneas de vida:
    # p-viewer: 117, p-owner: 327, p-gw: 525, p-pep: 742, p-pdp: 1002, p-db: 1255
    add_vertex(
        seq_root,
        "seq-frame-a",
        "<b>Caso A · Usuario con rol viewer intenta dibujar por WebSocket (acción canvas:edit)</b>",
        f"rounded=0;html=1;whiteSpace=wrap;fillColor=none;strokeColor={RED_STROKE};align=left;verticalAlign=top;spacingLeft=8;spacingTop=4;fontSize=10;fontColor={RED_STROKE};dashed=1;",
        20,
        90,
        1350,
        280,
    )
    steps_a = [
        (117, 742, 145, "1. WS send {type:'ops', ops:[add rect]}", "#000000"),
        (742, 1002, 185, "2. Cache MISS → GET /internal/boards/{id}/access?action=canvas:edit", RED_STROKE),
        (1002, 1255, 225, "3. SELECT role FROM board_members (uq_board_user)", "#000000"),
        (1255, 1002, 265, "4. role = 'viewer'", "#4B5563"),
        (1002, 742, 305, "5. 200 OK {role:'viewer', allowed:false, ttl:2s}", RED_STROKE),
        (742, 117, 345, "6. PEP bloquea operación (seq no cambia) → WS {type:'error', code:'forbidden'}", RED_STROKE),
    ]
    for idx, (sx, tx, y, text_lbl, col) in enumerate(steps_a, start=1):
        add_edge(
            seq_root,
            f"seq-a-{idx}",
            f"endArrow=classic;html=1;strokeColor={col};strokeWidth=1.5;",
            sx,
            y,
            tx,
            y,
        )
        lx = min(sx, tx) + 10
        lw = abs(tx - sx) - 20
        add_vertex(
            seq_root,
            f"seq-a-lbl-{idx}",
            text_lbl,
            f"text;html=1;align=center;verticalAlign=middle;fontSize=9;fontColor={col};labelBackgroundColor=#FFFFFF;",
            lx,
            y - 18,
            lw,
            16,
        )

    add_vertex(
        seq_root,
        "seq-frame-b",
        "<b>Caso B · Owner degrada o expulsa a un Editor mientras tiene el WebSocket abierto (revocación ≤ 5 s)</b>",
        f"rounded=0;html=1;whiteSpace=wrap;fillColor=none;strokeColor={RED_STROKE};align=left;verticalAlign=top;spacingLeft=8;spacingTop=4;fontSize=10;fontColor={RED_STROKE};dashed=1;",
        20,
        395,
        1350,
        345,
    )
    steps_b = [
        (327, 525, 450, "1. PATCH / DELETE /api/boards/{id}/members/{uid}", "#000000"),
        (525, 1002, 490, "2. Proxy → collaboration-api (requiere member:manage → owner)", "#000000"),
        (1002, 1255, 530, "3. UPDATE / DELETE board_members → 200 / 204", "#000000"),
        (117, 742, 575, "4. Editor envía {type:'ops'/'draft'} o vence ROLE_RECHECK (2–3 s)", "#000000"),
        (742, 1002, 615, "5. TTL expirado (≤ 2 s) → GET /internal/boards/{id}/access?action=canvas:edit", RED_STROKE),
        (1002, 742, 655, "6. Degradado: 200 {allowed:false} · Expulsado: 404 Not Found", RED_STROKE),
        (742, 117, 700, "7. PEP revoca en ≤ 5 s (medido 0,56–0,67 s): error:forbidden o WS Close 4403", RED_STROKE),
    ]
    for idx, (sx, tx, y, text_lbl, col) in enumerate(steps_b, start=1):
        add_edge(
            seq_root,
            f"seq-b-{idx}",
            f"endArrow=classic;html=1;strokeColor={col};strokeWidth=1.5;",
            sx,
            y,
            tx,
            y,
        )
        lx = min(sx, tx) + 10
        lw = abs(tx - sx) - 20
        add_vertex(
            seq_root,
            f"seq-b-lbl-{idx}",
            text_lbl,
            f"text;html=1;align=center;verticalAlign=middle;fontSize=9;fontColor={col};labelBackgroundColor=#FFFFFF;",
            lx,
            y - 18,
            lw,
            16,
        )

    ET.ElementTree(seq_mx).write(out_diag_dir / "secuencia-s5.drawio", encoding="utf-8")


if __name__ == "__main__":
    p3_root = pathlib.Path(__file__).resolve().parents[1]
    s1_diag = p3_root.parent / "Escenario compañero" / "CollaBoard-p3-s1-tls" / "docs" / "p3" / "diagramas"
    out_diag = p3_root / "docs" / "p3" / "diagramas"
    build_all_diagrams(s1_diag, out_diag)
    print("Archivos .drawio de S5 regenerados sin solapamientos.")
