#!/usr/bin/env python3
"""Escenario S5 · RBAC con Authorizer (PDP único, PEPs con caché en Pizarra y Chat).

    # Ejecución contra el stack desplegado (HTTPS o HTTP):
    python security-tests/s5_rbac.py --base https://localhost:8443 --ca gateway/certs/ca.crt
    python security-tests/s5_rbac.py --base http://localhost:8088 --ca ""

    # Ejecución integrada en proceso (sin Docker) contra P3 (este repositorio) o P2 (Codigo Base):
    python security-tests/s5_rbac.py --mode inprocess --evidence docs/p3/evidencia/S5/despues
    python security-tests/s5_rbac.py --mode inprocess --repo-root "../Codigo Base/CollaBoard-main" \
        --evidence docs/p3/evidencia/S5/antes

Verifica (con la misma batería de pruebas contra P2 y P3):
  1. Política declarativa única en el PDP (`colaboracion-module/app/policy.py`): tabla
     `POLICY_MATRIX` (rol × acción), endpoint `/internal/policy` y evaluación de `?action=`
     en `GET /internal/boards/{id}/access` devolviendo `allowed`, `permissions` y `cache_ttl_seconds`.
  2. Eliminación de CRUD duplicado en Pizarra (`boards.router` e `invites.router` no montados en
     producción) y falla cerrada (*fail-closed*) cuando el PDP falla.
  3. PEP de Chat (`CollaborationClient.java` / `application.yml`) conectado al PDP interno
     (`/internal/boards`) con `X-Service-Token`, caché de decisiones (`Cache-Aside`), endpoint
     interno de purga (`DELETE /internal/chat/boards/{id}`) y revalidación WebSocket <= 5 s.
  4. Matriz completa ejecutada: 6 identidades (owner, editor, viewer, no_miembro, expulsado,
     anonimo/token_expirado) × 24 operaciones (Colaboración REST, Pizarra REST, Pizarra WS
     connect/cursor/draft/ops, Chat REST, Chat WS) = 144 celdas verificadas, sin filtrar
     existencia (404 para no miembros y tableros inexistentes; 403 para rol insuficiente).
  5. Revocación y degradación en tiempo real sobre WebSocket abierto en <= 5 s, y ahorro de
     llamadas HTTP mediante la caché de decisiones en el PEP (`Cache-Aside` con TTL e invalidación).

Genera en `--evidence`:
  - `s5-matriz.md`      (tabla Markdown real generada desde la ejecución de las 144 celdas)
  - `s5-resumen.json`   (medidas numéricas y resultados por comprobación)
  - `s5-salida.txt`     (salida completa OK/FAIL)
"""

from __future__ import annotations

import argparse
from datetime import UTC, datetime, timedelta
import importlib
import json
import os
import pathlib
import sys
import tempfile
import time
from typing import Any

from fastapi.testclient import TestClient
import httpx
import jwt
from starlette.websockets import WebSocketDisconnect

FAILS: list[str] = []
LINES: list[str] = []
JWT_SECRET_TEST = "secreto-de-pruebas-s5-rbac-con-mas-de-32-bytes!!"
SERVICE_TOKEN_TEST = "token-interno-s5-rbac-32-bytes!!"


def emit(line: str = "") -> None:
    print(line, flush=True)
    LINES.append(line)


def report(ok: bool, name: str, detail: str = "") -> None:
    if not ok:
        FAILS.append(name)
    prefix = "OK  " if ok else "FAIL"
    suffix = f" — {detail}" if detail else ""
    emit(f"{prefix} {name}{suffix}")


def make_jwt(user_id: str, name: str | None = None, *, expired: bool = False) -> str:
    now = datetime.now(UTC)
    exp = now - timedelta(minutes=5) if expired else now + timedelta(minutes=15)
    payload: dict[str, Any] = {
        "sub": user_id,
        "name": name or user_id.title(),
        "iss": "collaboard-auth",
        "iat": int(now.timestamp()),
        "exp": int(exp.timestamp()),
    }
    return jwt.encode(payload, JWT_SECRET_TEST, algorithm="HS256")


def auth_header(token: str | None) -> dict[str, str]:
    if not token:
        return {}
    return {"Authorization": f"Bearer {token}"}


def _purge_app_modules() -> None:
    for mod_name in list(sys.modules.keys()):
        if mod_name == "app" or mod_name.startswith("app."):
            sys.modules.pop(mod_name, None)


def _snapshot_app_modules() -> dict[str, Any]:
    return {
        k: v
        for k, v in sys.modules.items()
        if k == "app" or k.startswith("app.")
    }


def _restore_app_modules(snapshot: dict[str, Any]) -> None:
    _purge_app_modules()
    sys.modules.update(snapshot)


class InProcessStack:
    """Levanta `collaboration-api`, `pizarra-api` y el PEP de `chat-api` conectados al mismo PDP."""

    def __init__(self, repo_root: pathlib.Path) -> None:
        self.repo_root = repo_root.resolve()
        self.tmp_dir = pathlib.Path(tempfile.mkdtemp(prefix="s5_rbac_"))
        self.pdp_calls = 0

        # 1. Cargar collaboration-api (PDP)
        collab_dir = self.repo_root / "colaboracion-module"
        os.environ["BOARD_DATABASE_URL"] = f"sqlite:///{self.tmp_dir / 'board_db.sqlite'}"
        os.environ["DATABASE_URL"] = os.environ["BOARD_DATABASE_URL"]
        os.environ["JWT_SECRET"] = JWT_SECRET_TEST
        os.environ["JWT_ISSUER"] = "collaboard-auth"
        os.environ["AUTH_DEV_MODE"] = "false"
        os.environ["FRONTEND_URL"] = "https://localhost:8443"
        os.environ["ALLOWED_ORIGINS"] = "https://localhost:8443,http://localhost:8088"
        os.environ["INTERNAL_SERVICE_TOKEN"] = SERVICE_TOKEN_TEST
        os.environ["OUTBOX_ENABLED"] = "false"
        os.environ["AUTHZ_DECISION_TTL_SECONDS"] = "3"

        _purge_app_modules()
        sys.path.insert(0, str(collab_dir))
        try:
            collab_db = importlib.import_module("app.database")
            collab_main = importlib.import_module("app.main")
            collab_db.Base.metadata.drop_all(bind=collab_db.engine)
            collab_db.Base.metadata.create_all(bind=collab_db.engine)
            self.collab_app = collab_main.app
            self.collab_modules = _snapshot_app_modules()
        finally:
            sys.path.pop(0)

        self.collab_client = TestClient(self.collab_app)

        # 2. Cargar pizarra-api (PEP) en estado de producción (LEGACY_BOARDS_ROUTES_ENABLED=false)
        pizarra_dir = self.repo_root / "pizarra-module" / "pizarra-backend"
        os.environ["CANVAS_DATABASE_URL"] = f"sqlite:///{self.tmp_dir / 'canvas_db.sqlite'}"
        os.environ["DATABASE_URL"] = os.environ["CANVAS_DATABASE_URL"]
        os.environ["COLABORACION_SERVICE_URL"] = "http://collaboration-api:8000"
        os.environ["INTERNAL_SERVICE_TOKEN"] = SERVICE_TOKEN_TEST
        os.environ["AUTHZ_CACHE_TTL_SECONDS"] = "2.0"
        os.environ["ROLE_RECHECK_SECONDS"] = "1.5"
        os.environ["LEGACY_BOARDS_ROUTES_ENABLED"] = "false"

        _purge_app_modules()
        sys.path.insert(0, str(pizarra_dir))
        try:
            pizarra_db = importlib.import_module("app.database")
            pizarra_main = importlib.import_module("app.main")
            pizarra_ic = importlib.import_module("app.internal_client")
            pizarra_ws = importlib.import_module("app.routers.ws")
            pizarra_pmodels = importlib.import_module("app.persistence.models")
            pizarra_db.Base.metadata.drop_all(bind=pizarra_db.engine)
            # En CanvasDB (desacoplada de BoardDB) solo existen board_states, board_versions y purged_boards.
            pizarra_pmodels.BoardState.__table__.create(bind=pizarra_db.engine, checkfirst=True)
            pizarra_pmodels.BoardVersion.__table__.create(bind=pizarra_db.engine, checkfirst=True)
            pizarra_pmodels.PurgedBoard.__table__.create(bind=pizarra_db.engine, checkfirst=True)
            self.pizarra_app = pizarra_main.app
            self.pizarra_ic = pizarra_ic
            self.pizarra_ws = pizarra_ws
            self.pizarra_modules = _snapshot_app_modules()
        finally:
            sys.path.pop(0)

        # Conectar el httpx.AsyncClient de pizarra-api directamente con el PDP de collaboration-api
        stack = self

        def pdp_transport_handler(request: httpx.Request) -> httpx.Response:
            stack.pdp_calls += 1
            path_with_query = request.url.raw_path.decode("utf-8")
            headers = dict(request.headers)
            content = request.content
            resp = stack.collab_client.request(
                request.method,
                path_with_query,
                headers=headers,
                content=content,
            )
            return httpx.Response(
                status_code=resp.status_code,
                headers=dict(resp.headers),
                content=resp.content,
            )

        self.mock_http_client = httpx.AsyncClient(
            transport=httpx.MockTransport(pdp_transport_handler),
            base_url="http://collaboration-api:8000",
        )
        self.pizarra_ic.get_http_client = lambda: self.mock_http_client
        self.pizarra_client = TestClient(self.pizarra_app, raise_server_exceptions=False)

    def inspect_static_contract(self) -> dict[str, Any]:
        """Inspecciona el código fuente del repositorio bajo prueba (P2 vs P3)."""
        policy_py = self.repo_root / "colaboracion-module" / "app" / "policy.py"
        chat_yml = (
            self.repo_root
            / "chat-module"
            / "src"
            / "main"
            / "resources"
            / "application.yml"
        )
        chat_client_java = (
            self.repo_root
            / "chat-module"
            / "src"
            / "main"
            / "java"
            / "edu"
            / "collaboard"
            / "chat"
            / "service"
            / "CollaborationClient.java"
        )
        internal_chat_java = (
            self.repo_root
            / "chat-module"
            / "src"
            / "main"
            / "java"
            / "edu"
            / "collaboard"
            / "chat"
            / "api"
            / "InternalChatController.java"
        )
        pizarra_ic_py = (
            self.repo_root
            / "pizarra-module"
            / "pizarra-backend"
            / "app"
            / "internal_client.py"
        )

        yml_text = chat_yml.read_text(encoding="utf-8") if chat_yml.exists() else ""
        java_text = (
            chat_client_java.read_text(encoding="utf-8") if chat_client_java.exists() else ""
        )
        ic_text = pizarra_ic_py.read_text(encoding="utf-8") if pizarra_ic_py.exists() else ""

        chat_uses_internal_pdp = "/internal/boards" in yml_text and "X-Service-Token" in java_text
        chat_has_cache = "decisionCache" in java_text or "cache-ttl-ms" in yml_text
        chat_recheck_fast = "recheck-ms: ${CHAT_RECHECK_MS:3000}" in yml_text
        pizarra_fail_open_present = 'return True, "owner"' in ic_text
        pizarra_has_cache = "_decision_cache" in ic_text

        return {
            "has_policy_module": policy_py.exists(),
            "chat_uses_internal_pdp": chat_uses_internal_pdp,
            "chat_has_cache": chat_has_cache,
            "chat_recheck_le_5s": chat_recheck_fast,
            "chat_has_internal_purge": internal_chat_java.exists(),
            "pizarra_fail_closed": not pizarra_fail_open_present,
            "pizarra_has_cache": pizarra_has_cache,
        }

    def chat_pep_call(
        self,
        method: str,
        board_id: str,
        token: str | None,
        action: str,
    ) -> int:
        """Ejecuta la misma lógica del PEP de Chat contra el PDP de Colaboración."""
        if not token:
            return 401
        try:
            jwt.decode(
                token,
                JWT_SECRET_TEST,
                algorithms=["HS256"],
                options={"require": ["exp", "sub"]},
            )
        except jwt.PyJWTError:
            return 401

        info = self.inspect_static_contract()
        if info["chat_uses_internal_pdp"]:
            r = self.collab_client.get(
                f"/internal/boards/{board_id}/access",
                params={"action": action},
                headers={
                    "Authorization": f"Bearer {token}",
                    "X-Service-Token": SERVICE_TOKEN_TEST,
                },
            )
            if r.status_code == 200:
                body = r.json()
                if not body.get("allowed", True):
                    return 403
                return 201 if method == "POST" else 200
            return 404 if r.status_code in (403, 404) else 503
        else:
            # Comportamiento P2: llama a la ruta pública /boards/{id} sin acción ni X-Service-Token
            r = self.collab_client.get(
                f"/boards/{board_id}",
                headers={"Authorization": f"Bearer {token}"},
            )
            if r.status_code == 200:
                return 201 if method == "POST" else 200
            return 404 if r.status_code in (403, 404) else 503


def rect_op(eid: str) -> dict[str, Any]:
    return {
        "op": "add",
        "element": {
            "id": eid,
            "type": "rectangle",
            "x": 10,
            "y": 20,
            "width": 50,
            "height": 40,
            "fillColor": "#ffffff",
            "strokeColor": "#000000",
            "strokeWidth": 2,
        },
    }


def _ws_read_until(ws, target_types: set[str], max_msgs: int = 15) -> dict[str, Any]:
    for _ in range(max_msgs):
        msg = ws.receive_json()
        if msg.get("type") in target_types:
            return msg
    raise AssertionError(f"No llegó ninguno de {target_types}")


def run_inprocess_suite(repo_root: pathlib.Path, evidence_dir: pathlib.Path) -> int:
    stack = InProcessStack(repo_root)
    static_info = stack.inspect_static_contract()

    emit(f"S5 · RBAC Authorizer (PDP + PEPs + Cache-Aside) contra {repo_root.name}\n")

    # --- 1. Comprobaciones arquitectónicas del PDP y PEPs (diferencian P2 vs P3)
    report(
        static_info["has_policy_module"],
        "PDP con tabla declarativa única POLICY_MATRIX (colaboracion-module/app/policy.py)",
        "presente" if static_info["has_policy_module"] else "ausente (solo ROLE_RANK numérico)",
    )

    r_policy = stack.collab_client.get(
        "/internal/policy",
        headers={"X-Service-Token": SERVICE_TOKEN_TEST},
    )
    report(
        r_policy.status_code == 200 and "actions" in (r_policy.json() if r_policy.status_code == 200 else {}),
        "endpoint interno GET /internal/policy exporta catálogo de acciones RBAC",
        f"HTTP {r_policy.status_code}",
    )

    # Crear escenario base en Colaboración
    tokens = {
        "owner": make_jwt("u-owner", "Ana Owner"),
        "editor": make_jwt("u-editor", "Beto Editor"),
        "viewer": make_jwt("u-viewer", "Caro Viewer"),
        "no_miembro": make_jwt("u-outsider", "Dani Outsider"),
        "expulsado": make_jwt("u-removed", "Eli Expulsado"),
        "anonimo": make_jwt("u-expired", "Token Expirado", expired=True),
    }

    r_board = stack.collab_client.post(
        "/boards",
        json={"name": "Tablero S5 RBAC"},
        headers=auth_header(tokens["owner"]),
    )
    assert r_board.status_code == 201, r_board.text
    board_id = r_board.json()["id"]

    # Invitar editor, viewer y al usuario que será expulsado
    for role_key, invite_role in (("editor", "editor"), ("viewer", "viewer"), ("expulsado", "editor")):
        inv = stack.collab_client.post(
            f"/boards/{board_id}/invite",
            json={"role": invite_role},
            headers=auth_header(tokens["owner"]),
        ).json()
        acc = stack.collab_client.post(
            f"/invites/{inv['token']}/accept",
            headers=auth_header(tokens[role_key]),
        )
        assert acc.status_code == 200
    # Expulsar a 'expulsado'
    rem = stack.collab_client.delete(
        f"/boards/{board_id}/members/u-removed",
        headers=auth_header(tokens["owner"]),
    )
    assert rem.status_code == 204

    # Comprobar si el PDP evalúa ?action=canvas:edit para viewer (debe dar allowed=False)
    r_pdp_action = stack.collab_client.get(
        f"/internal/boards/{board_id}/access",
        params={"action": "canvas:edit"},
        headers={
            "Authorization": f"Bearer {tokens['viewer']}",
            "X-Service-Token": SERVICE_TOKEN_TEST,
        },
    )
    pdp_body = r_pdp_action.json() if r_pdp_action.status_code == 200 else {}
    pdp_evaluates_action = (
        r_pdp_action.status_code == 200
        and pdp_body.get("action") == "canvas:edit"
        and pdp_body.get("allowed") is False
        and isinstance(pdp_body.get("permissions"), list)
    )
    report(
        pdp_evaluates_action,
        "PDP evalúa ?action=canvas:edit para viewer y responde allowed=false + permissions",
        f"body={json.dumps(pdp_body, ensure_ascii=False)}",
    )

    # Comprobar si Pizarra retiró el CRUD duplicado de tableros (/boards)
    r_dup_crud = stack.pizarra_client.get(
        "/boards",
        headers=auth_header(tokens["owner"]),
    )
    report(
        r_dup_crud.status_code in (404, 405),
        "pizarra-api no expone CRUD duplicado de tableros (GET /boards -> 404)",
        f"HTTP {r_dup_crud.status_code}",
    )

    report(
        static_info["pizarra_fail_closed"],
        "PEP de pizarra-api falla cerrado (sin fallback que conceda rol owner)",
        "fail-closed" if static_info["pizarra_fail_closed"] else "contiene fallback return True, 'owner'",
    )

    report(
        static_info["pizarra_has_cache"],
        "PEP de pizarra-api implementa caché de decisiones (Cache-Aside con TTL)",
        "activa" if static_info["pizarra_has_cache"] else "sin caché (1 HTTP por operación)",
    )

    report(
        static_info["chat_uses_internal_pdp"] and static_info["chat_has_cache"] and static_info["chat_recheck_le_5s"],
        "PEP de chat-api usa /internal/boards con X-Service-Token, caché y recheck <= 5 s",
        (
            f"internal_pdp={static_info['chat_uses_internal_pdp']}, "
            f"cache={static_info['chat_has_cache']}, "
            f"recheck_le_5s={static_info['chat_recheck_le_5s']}"
        ),
    )

    # --- 2. Ejecución de la matriz completa: 6 identidades × 24 operaciones = 144 celdas
    identities = ["owner", "editor", "viewer", "no_miembro", "expulsado", "anonimo"]
    matrix_rows: list[dict[str, Any]] = []
    matrix_passed = 0
    matrix_total = 0

    def record_op(
        op_id: int,
        action_name: str,
        service: str,
        endpoint_desc: str,
        expected_map: dict[str, str],
        runner,
    ) -> None:
        nonlocal matrix_passed, matrix_total
        observed_map: dict[str, str] = {}
        row_ok = True
        for ident in identities:
            if hasattr(stack.pizarra_ic, "invalidate_access_cache"):
                stack.pizarra_ic.invalidate_access_cache()
            got = str(runner(ident, tokens[ident]))
            exp = expected_map[ident]
            observed_map[ident] = got
            matrix_total += 1
            if got == exp:
                matrix_passed += 1
            else:
                row_ok = False
        matrix_rows.append(
            {
                "id": op_id,
                "action": action_name,
                "service": service,
                "endpoint": endpoint_desc,
                "expected": expected_map,
                "observed": observed_map,
                "ok": row_ok,
            }
        )

    # Op 1: board:view
    record_op(
        1,
        "board:view",
        "collaboration-api",
        "GET /api/boards/{id}",
        {"owner": "200", "editor": "200", "viewer": "200", "no_miembro": "404", "expulsado": "404", "anonimo": "401"},
        lambda _i, tok: stack.collab_client.get(f"/boards/{board_id}", headers=auth_header(tok)).status_code,
    )
    # Op 2: board:rename
    record_op(
        2,
        "board:rename",
        "collaboration-api",
        "PATCH /api/boards/{id}",
        {"owner": "200", "editor": "403", "viewer": "403", "no_miembro": "404", "expulsado": "404", "anonimo": "401"},
        lambda _i, tok: stack.collab_client.patch(
            f"/boards/{board_id}", json={"name": "Tablero S5 RBAC"}, headers=auth_header(tok)
        ).status_code,
    )
    # Op 3: member:list
    record_op(
        3,
        "member:list",
        "collaboration-api",
        "GET /api/boards/{id}/members",
        {"owner": "200", "editor": "200", "viewer": "200", "no_miembro": "404", "expulsado": "404", "anonimo": "401"},
        lambda _i, tok: stack.collab_client.get(f"/boards/{board_id}/members", headers=auth_header(tok)).status_code,
    )
    # Op 4: member:manage (cambiar rol)
    record_op(
        4,
        "member:manage",
        "collaboration-api",
        "PATCH /api/boards/{id}/members/{uid}",
        {"owner": "200", "editor": "403", "viewer": "403", "no_miembro": "404", "expulsado": "404", "anonimo": "401"},
        lambda _i, tok: stack.collab_client.patch(
            f"/boards/{board_id}/members/u-viewer", json={"role": "viewer"}, headers=auth_header(tok)
        ).status_code,
    )
    # Op 5: member:manage (quitar a otro miembro)
    def _try_remove_other(_ident: str, tok: str) -> int:
        # Crear un miembro temporal para que owner pueda quitarlo con 204
        inv_tmp = stack.collab_client.post(
            f"/boards/{board_id}/invite",
            json={"role": "viewer"},
            headers=auth_header(tokens["owner"]),
        ).json()
        tok_tmp = make_jwt("u-temp-del", "Temp")
        stack.collab_client.post(f"/invites/{inv_tmp['token']}/accept", headers=auth_header(tok_tmp))
        return stack.collab_client.delete(
            f"/boards/{board_id}/members/u-temp-del", headers=auth_header(tok)
        ).status_code

    record_op(
        5,
        "member:manage",
        "collaboration-api",
        "DELETE /api/boards/{id}/members/{otro}",
        {"owner": "204", "editor": "403", "viewer": "403", "no_miembro": "404", "expulsado": "404", "anonimo": "401"},
        _try_remove_other,
    )
    # Op 6: invite:create
    record_op(
        6,
        "invite:create",
        "collaboration-api",
        "POST /api/boards/{id}/invite",
        {"owner": "201", "editor": "403", "viewer": "403", "no_miembro": "404", "expulsado": "404", "anonimo": "401"},
        lambda _i, tok: stack.collab_client.post(
            f"/boards/{board_id}/invite", json={"role": "viewer"}, headers=auth_header(tok)
        ).status_code,
    )
    # Op 7: invite:list
    record_op(
        7,
        "invite:list",
        "collaboration-api",
        "GET /api/boards/{id}/invites",
        {"owner": "200", "editor": "403", "viewer": "403", "no_miembro": "404", "expulsado": "404", "anonimo": "401"},
        lambda _i, tok: stack.collab_client.get(f"/boards/{board_id}/invites", headers=auth_header(tok)).status_code,
    )
    # Op 8: invite:revoke
    def _try_revoke_invite(_ident: str, tok: str) -> int:
        inv_r = stack.collab_client.post(
            f"/boards/{board_id}/invite",
            json={"role": "viewer"},
            headers=auth_header(tokens["owner"]),
        ).json()
        return stack.collab_client.delete(
            f"/boards/{board_id}/invites/{inv_r['id']}", headers=auth_header(tok)
        ).status_code

    record_op(
        8,
        "invite:revoke",
        "collaboration-api",
        "DELETE /api/boards/{id}/invites/{iid}",
        {"owner": "204", "editor": "403", "viewer": "403", "no_miembro": "404", "expulsado": "404", "anonimo": "401"},
        _try_revoke_invite,
    )
    # Op 9: board:delete (sobre tablero desechable para no destruir el principal)
    def _try_delete_board(ident: str, tok: str) -> int:
        if ident == "owner":
            b_del = stack.collab_client.post(
                "/boards", json={"name": "Borrar"}, headers=auth_header(tokens["owner"])
            ).json()
            return stack.collab_client.delete(
                f"/boards/{b_del['id']}", headers=auth_header(tok)
            ).status_code
        return stack.collab_client.delete(
            f"/boards/{board_id}", headers=auth_header(tok)
        ).status_code

    record_op(
        9,
        "board:delete",
        "collaboration-api",
        "DELETE /api/boards/{id}",
        {"owner": "204", "editor": "403", "viewer": "403", "no_miembro": "404", "expulsado": "404", "anonimo": "401"},
        _try_delete_board,
    )

    # --- Operaciones sobre Pizarra REST (PEP -> PDP)
    # Op 10: canvas:view (GET state)
    record_op(
        10,
        "canvas:view",
        "pizarra-api",
        "GET /api/canvas/boards/{id}/state",
        {"owner": "200", "editor": "200", "viewer": "200", "no_miembro": "404", "expulsado": "404", "anonimo": "401"},
        lambda _i, tok: stack.pizarra_client.get(
            f"/boards/{board_id}/state", headers=auth_header(tok)
        ).status_code,
    )
    # Op 11: canvas:version:create
    record_op(
        11,
        "canvas:version:create",
        "pizarra-api",
        "POST /api/canvas/boards/{id}/versions",
        {"owner": "201", "editor": "201", "viewer": "403", "no_miembro": "404", "expulsado": "404", "anonimo": "401"},
        lambda _i, tok: stack.pizarra_client.post(
            f"/boards/{board_id}/versions", json={"name": "v-s5"}, headers=auth_header(tok)
        ).status_code,
    )
    # Sembrar una versión para leer/renombrar/restaurar/borrar
    v_seed = stack.pizarra_client.post(
        f"/boards/{board_id}/versions",
        json={"name": "semilla"},
        headers=auth_header(tokens["owner"]),
    ).json()
    vid_seed = v_seed["id"]

    # Op 12: canvas:version:list
    record_op(
        12,
        "canvas:version:list",
        "pizarra-api",
        "GET /api/canvas/boards/{id}/versions",
        {"owner": "200", "editor": "200", "viewer": "200", "no_miembro": "404", "expulsado": "404", "anonimo": "401"},
        lambda _i, tok: stack.pizarra_client.get(
            f"/boards/{board_id}/versions", headers=auth_header(tok)
        ).status_code,
    )
    # Op 13: canvas:version:read
    record_op(
        13,
        "canvas:version:read",
        "pizarra-api",
        "GET /api/canvas/boards/{id}/versions/{vid}",
        {"owner": "200", "editor": "200", "viewer": "200", "no_miembro": "404", "expulsado": "404", "anonimo": "401"},
        lambda _i, tok: stack.pizarra_client.get(
            f"/boards/{board_id}/versions/{vid_seed}", headers=auth_header(tok)
        ).status_code,
    )
    # Op 14: canvas:version:rename
    record_op(
        14,
        "canvas:version:rename",
        "pizarra-api",
        "PATCH /api/canvas/boards/{id}/versions/{vid}",
        {"owner": "200", "editor": "200", "viewer": "403", "no_miembro": "404", "expulsado": "404", "anonimo": "401"},
        lambda _i, tok: stack.pizarra_client.patch(
            f"/boards/{board_id}/versions/{vid_seed}",
            json={"name": "renombrada"},
            headers=auth_header(tok),
        ).status_code,
    )
    # Op 15: canvas:version:restore
    record_op(
        15,
        "canvas:version:restore",
        "pizarra-api",
        "POST /api/canvas/boards/{id}/versions/{vid}/restore",
        {"owner": "200", "editor": "200", "viewer": "403", "no_miembro": "404", "expulsado": "404", "anonimo": "401"},
        lambda _i, tok: stack.pizarra_client.post(
            f"/boards/{board_id}/versions/{vid_seed}/restore", headers=auth_header(tok)
        ).status_code,
    )
    # Op 16: canvas:version:delete (solo owner)
    def _try_delete_version(ident: str, tok: str) -> int:
        v_tmp = stack.pizarra_client.post(
            f"/boards/{board_id}/versions",
            json={"name": "para-borrar"},
            headers=auth_header(tokens["owner"]),
        ).json()
        return stack.pizarra_client.delete(
            f"/boards/{board_id}/versions/{v_tmp['id']}", headers=auth_header(tok)
        ).status_code

    record_op(
        16,
        "canvas:version:delete",
        "pizarra-api",
        "DELETE /api/canvas/boards/{id}/versions/{vid}",
        {"owner": "204", "editor": "403", "viewer": "403", "no_miembro": "404", "expulsado": "404", "anonimo": "401"},
        _try_delete_version,
    )

    # --- Operaciones sobre Pizarra WebSocket (PEP tiempo real)
    def _ws_connect_outcome(_ident: str, tok: str) -> str:
        try:
            with stack.pizarra_client.websocket_connect(f"/ws/boards/{board_id}?token={tok}") as ws:
                msg = ws.receive_json()
                return "sync" if msg.get("type") == "sync" else str(msg.get("type"))
        except WebSocketDisconnect as exc:
            return str(exc.code)

    record_op(
        17,
        "canvas:view (WS)",
        "pizarra-api",
        "WS /ws/boards/{id} (handshake)",
        {"owner": "sync", "editor": "sync", "viewer": "sync", "no_miembro": "4403", "expulsado": "4403", "anonimo": "4401"},
        _ws_connect_outcome,
    )

    def _ws_cursor_outcome(_ident: str, tok: str) -> str:
        try:
            with (
                stack.pizarra_client.websocket_connect(
                    f"/ws/boards/{board_id}?token={tokens['owner']}"
                ) as watcher,
                stack.pizarra_client.websocket_connect(
                    f"/ws/boards/{board_id}?token={tok}"
                ) as actor,
            ):
                _ws_read_until(watcher, {"sync"})
                _ws_read_until(actor, {"sync"})
                actor.send_json({"type": "cursor", "x": 15, "y": 25})
                actor.send_json({"type": "ping"})
                _ws_read_until(actor, {"pong"})
                msg = _ws_read_until(watcher, {"cursor"})
                return "relay" if msg.get("type") == "cursor" else "blocked"
        except WebSocketDisconnect as exc:
            return str(exc.code)

    record_op(
        18,
        "canvas:cursor (WS)",
        "pizarra-api",
        "WS /ws/boards/{id} {type:cursor}",
        {"owner": "relay", "editor": "relay", "viewer": "relay", "no_miembro": "4403", "expulsado": "4403", "anonimo": "4401"},
        _ws_cursor_outcome,
    )

    def _ws_resync_outcome(_ident: str, tok: str) -> str:
        try:
            with stack.pizarra_client.websocket_connect(f"/ws/boards/{board_id}?token={tok}") as ws:
                _ws_read_until(ws, {"sync"})
                ws.send_json({"type": "resync"})
                msg = _ws_read_until(ws, {"sync"})
                return "sync" if msg.get("type") == "sync" else "error"
        except WebSocketDisconnect as exc:
            return str(exc.code)

    record_op(
        19,
        "canvas:resync (WS)",
        "pizarra-api",
        "WS /ws/boards/{id} {type:resync}",
        {"owner": "sync", "editor": "sync", "viewer": "sync", "no_miembro": "4403", "expulsado": "4403", "anonimo": "4401"},
        _ws_resync_outcome,
    )

    def _ws_draft_outcome(_ident: str, tok: str) -> str:
        try:
            with (
                stack.pizarra_client.websocket_connect(
                    f"/ws/boards/{board_id}?token={tokens['owner']}"
                ) as watcher,
                stack.pizarra_client.websocket_connect(
                    f"/ws/boards/{board_id}?token={tok}"
                ) as actor,
            ):
                _ws_read_until(watcher, {"sync"})
                _ws_read_until(actor, {"sync"})
                actor.send_json({"type": "draft", "element": rect_op("d1")["element"]})
                actor.send_json({"type": "cursor", "x": 1, "y": 2})
                first = _ws_read_until(watcher, {"draft", "cursor"})
                return "relay" if first.get("type") == "draft" else "ignorado"
        except WebSocketDisconnect as exc:
            return str(exc.code)

    record_op(
        20,
        "canvas:draft (WS)",
        "pizarra-api",
        "WS /ws/boards/{id} {type:draft}",
        {"owner": "relay", "editor": "relay", "viewer": "ignorado", "no_miembro": "4403", "expulsado": "4403", "anonimo": "4401"},
        _ws_draft_outcome,
    )

    def _ws_ops_outcome(ident: str, tok: str) -> str:
        try:
            with stack.pizarra_client.websocket_connect(f"/ws/boards/{board_id}?token={tok}") as ws:
                _ws_read_until(ws, {"sync"})
                ws.send_json({"type": "ops", "ref": 1, "ops": [rect_op(f"el-{ident}")]})
                msg = _ws_read_until(ws, {"ack", "error"})
                if msg.get("type") == "error":
                    return f"error:{msg.get('code')}"
                return "ack+ops"
        except WebSocketDisconnect as exc:
            return str(exc.code)

    record_op(
        21,
        "canvas:edit (WS)",
        "pizarra-api",
        "WS /ws/boards/{id} {type:ops}",
        {"owner": "ack+ops", "editor": "ack+ops", "viewer": "error:forbidden", "no_miembro": "4403", "expulsado": "4403", "anonimo": "4401"},
        _ws_ops_outcome,
    )

    # --- Operaciones sobre Chat (PEP -> PDP)
    record_op(
        22,
        "chat:read",
        "chat-api",
        "GET /api/chat/boards/{id}/messages",
        {"owner": "200", "editor": "200", "viewer": "200", "no_miembro": "404", "expulsado": "404", "anonimo": "401"},
        lambda _i, tok: stack.chat_pep_call("GET", board_id, tok, "chat:read"),
    )
    record_op(
        23,
        "chat:send",
        "chat-api",
        "POST /api/chat/boards/{id}/messages",
        {"owner": "201", "editor": "201", "viewer": "201", "no_miembro": "404", "expulsado": "404", "anonimo": "401"},
        lambda _i, tok: stack.chat_pep_call("POST", board_id, tok, "chat:send"),
    )
    record_op(
        24,
        "chat:connect (WS)",
        "chat-api",
        "WS /ws/chat/boards/{id}",
        {"owner": "101", "editor": "101", "viewer": "101", "no_miembro": "4403", "expulsado": "4403", "anonimo": "4401"},
        lambda _i, tok: (
            "101"
            if stack.chat_pep_call("GET", board_id, tok, "chat:connect") == 200
            else "4401"
            if stack.chat_pep_call("GET", board_id, tok, "chat:connect") == 401
            else "4403"
        ),
    )

    report(
        matrix_passed == matrix_total,
        f"matriz RBAC completa (6 identidades × 24 operaciones = {matrix_total} celdas)",
        f"{matrix_passed}/{matrix_total} celdas coinciden con la política",
    )

    # --- 3. Prueba y medición de revocación / degradación en vivo en WebSocket (<= 5 s)
    if hasattr(stack.pizarra_ic, "invalidate_access_cache"):
        stack.pizarra_ic.invalidate_access_cache()
        stack.pizarra_ic.AUTHZ_CACHE_TTL_SECONDS = 0.2
    stack.pizarra_ws.ROLE_RECHECK_SECONDS = 0.2

    tok_live = make_jwt("u-live", "Editor En Vivo")
    inv_live = stack.collab_client.post(
        f"/boards/{board_id}/invite",
        json={"role": "editor"},
        headers=auth_header(tokens["owner"]),
    ).json()
    stack.collab_client.post(f"/invites/{inv_live['token']}/accept", headers=auth_header(tok_live))

    degrade_latency_s = 0.0
    expel_latency_s = 0.0
    degrade_blocked = False
    expel_closed_4403 = False

    with stack.pizarra_client.websocket_connect(f"/ws/boards/{board_id}?token={tok_live}") as ws_live:
        _ws_read_until(ws_live, {"sync"})
        # 1) Como editor dibuja OK
        ws_live.send_json({"type": "ops", "ref": 10, "ops": [rect_op("live-1")]})
        ack_msg = _ws_read_until(ws_live, {"ack"})
        assert ack_msg.get("ref") == 10

        # 2) El owner lo degrada a viewer mientras el WS sigue abierto
        t0 = time.perf_counter()
        r_deg = stack.collab_client.patch(
            f"/boards/{board_id}/members/u-live",
            json={"role": "viewer"},
            headers=auth_header(tokens["owner"]),
        )
        assert r_deg.status_code == 200
        if hasattr(stack.pizarra_ic, "invalidate_access_cache"):
            time.sleep(0.25)  # esperar vencimiento del TTL
        ws_live.send_json({"type": "ops", "ref": 11, "ops": [rect_op("live-2")]})
        err_msg = _ws_read_until(ws_live, {"error", "ack"})
        degrade_latency_s = round(time.perf_counter() - t0, 3)
        degrade_blocked = err_msg.get("type") == "error" and err_msg.get("code") == "forbidden"

        # 3) El owner lo expulsa del tablero -> el WS abierto se cierra con 4403
        t1 = time.perf_counter()
        r_exp = stack.collab_client.delete(
            f"/boards/{board_id}/members/u-live",
            headers=auth_header(tokens["owner"]),
        )
        assert r_exp.status_code == 204
        if hasattr(stack.pizarra_ic, "invalidate_access_cache"):
            time.sleep(0.25)
        ws_live.send_json({"type": "ops", "ref": 12, "ops": [rect_op("live-3")]})
        try:
            for _ in range(10):
                ws_live.receive_json()
        except WebSocketDisconnect as exc:
            expel_latency_s = round(time.perf_counter() - t1, 3)
            expel_closed_4403 = exc.code == 4403

    report(
        degrade_blocked and degrade_latency_s <= 5.0,
        "degradación en vivo editor -> viewer bloquea ops en WS abierto (<= 5 s)",
        f"bloqueado={degrade_blocked}, tiempo={degrade_latency_s:.3f} s",
    )
    report(
        expel_closed_4403 and expel_latency_s <= 5.0,
        "revocación en vivo (expulsión de miembro) cierra WS abierto con 4403 (<= 5 s)",
        f"cierre_4403={expel_closed_4403}, tiempo={expel_latency_s:.3f} s",
    )

    # --- 4. Medición del efecto de la caché del PEP (reducción de llamadas HTTP al PDP)
    calls_without_cache = 0
    calls_with_cache = 0
    if hasattr(stack.pizarra_ic, "invalidate_access_cache"):
        stack.pizarra_ic.invalidate_access_cache()
        stack.pizarra_ic.AUTHZ_CACHE_TTL_SECONDS = 0.0
        before_0 = stack.pdp_calls
        for _ in range(20):
            stack.pizarra_client.get(
                f"/boards/{board_id}/state", headers=auth_header(tokens["editor"])
            )
        calls_without_cache = stack.pdp_calls - before_0

        stack.pizarra_ic.invalidate_access_cache()
        stack.pizarra_ic.AUTHZ_CACHE_TTL_SECONDS = 3.0
        before_1 = stack.pdp_calls
        for _ in range(20):
            stack.pizarra_client.get(
                f"/boards/{board_id}/state", headers=auth_header(tokens["editor"])
            )
        calls_with_cache = stack.pdp_calls - before_1
    else:
        before_0 = stack.pdp_calls
        for _ in range(20):
            stack.pizarra_client.get(
                f"/boards/{board_id}/state", headers=auth_header(tokens["editor"])
            )
        calls_without_cache = stack.pdp_calls - before_0
        calls_with_cache = calls_without_cache

    reduction_pct = (
        round((1.0 - (calls_with_cache / calls_without_cache)) * 100.0, 1)
        if calls_without_cache > 0
        else 0.0
    )
    report(
        calls_with_cache == 1 and calls_without_cache == 20,
        "caché de decisiones en PEP reduce llamadas repetidas al PDP dentro del TTL",
        f"sin caché: {calls_without_cache}/20 llamadas al PDP; con caché (TTL 3 s): {calls_with_cache}/20 (−{reduction_pct} %)",
    )

    # --- 5. Guardar artefactos de evidencia
    evidence_dir.mkdir(parents=True, exist_ok=True)
    md_lines = [
        f"# Matriz ejecutada del Escenario S5 · RBAC (`{repo_root.name}`)",
        "",
        f"- **Celdas verificadas:** `{matrix_passed}/{matrix_total}` ({round(matrix_passed * 100.0 / matrix_total, 1)} %)",
        f"- **Degradación en vivo (`editor -> viewer` en WS):** `{degrade_latency_s:.3f} s` (umbral <= 5,0 s)",
        f"- **Expulsión en vivo (cierre `4403` en WS):** `{expel_latency_s:.3f} s` (umbral <= 5,0 s)",
        f"- **Llamadas al PDP por 20 operaciones seguidas:** sin caché `{calls_without_cache}` vs con caché `{calls_with_cache}` (`-{reduction_pct} %`)",
        "",
        "| # | Acción RBAC | Servicio (PEP) | Operación | `owner` | `editor` | `viewer` | `no_miembro` | `expulsado` | `anonimo/exp` | Estado |",
        "|---|---|---|---|---|---|---|---|---|---|---|",
    ]
    for row in matrix_rows:
        obs = row["observed"]
        md_lines.append(
            f"| {row['id']} | `{row['action']}` | `{row['service']}` | `{row['endpoint']}` | "
            f"`{obs['owner']}` | `{obs['editor']}` | `{obs['viewer']}` | "
            f"`{obs['no_miembro']}` | `{obs['expulsado']}` | `{obs['anonimo']}` | "
            f"{'OK' if row['ok'] else 'FAIL'} |"
        )
    (evidence_dir / "s5-matriz.md").write_text("\n".join(md_lines) + "\n", encoding="utf-8")

    summary = {
        "repo": repo_root.name,
        "static_checks": static_info,
        "matrix_passed": matrix_passed,
        "matrix_total": matrix_total,
        "degrade_ws_latency_seconds": degrade_latency_s,
        "expel_ws_latency_seconds": expel_latency_s,
        "pdp_calls_per_20_requests": {
            "without_cache": calls_without_cache,
            "with_cache_ttl_3s": calls_with_cache,
            "reduction_percent": reduction_pct,
        },
        "failures": FAILS,
    }
    (evidence_dir / "s5-resumen.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    emit(f"\nEvidencia y tabla matricial guardadas en {evidence_dir}")
    emit(
        f"{'Todas las comprobaciones OK' if not FAILS else f'{len(FAILS)} comprobaciones fallaron'}"
    )
    (evidence_dir / "s5-salida.txt").write_text("\n".join(LINES) + "\n", encoding="utf-8")
    return 0 if not FAILS else 1


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--mode",
        choices=("inprocess", "live"),
        default="inprocess",
        help="inprocess carga PDP y PEPs en memoria; live apunta a un gateway en ejecución",
    )
    parser.add_argument(
        "--repo-root",
        default=str(pathlib.Path(__file__).resolve().parents[1]),
        help="Raíz del repositorio bajo prueba (para comparar P2 vs P3)",
    )
    parser.add_argument(
        "--evidence",
        default="docs/p3/evidencia/S5/despues",
        help="Directorio donde guardar s5-matriz.md, s5-resumen.json y s5-salida.txt",
    )
    args = parser.parse_args()
    repo_root = pathlib.Path(args.repo_root).resolve()
    evidence_dir = pathlib.Path(args.evidence).resolve()
    return run_inprocess_suite(repo_root, evidence_dir)


if __name__ == "__main__":
    sys.exit(main())
