#!/usr/bin/env bash
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

temporal="$(mktemp -d /tmp/collaboard-s4-p2-XXXXXX)"

limpiar() {
    git worktree remove --force "$temporal" >/dev/null 2>&1 || true
    rmdir "$temporal" 2>/dev/null || true
}
trap limpiar EXIT

git worktree add --detach "$temporal" 6af0456

cat > "$temporal/authentication-module/internal/httpapi/s4_p2_evidence_test.go" <<'GO'
package httpapi

import (
    "encoding/base64"
    "encoding/json"
    "strings"
    "testing"
    "time"

    "github.com/CollaBoardUN/CollaBoard/authentication-module/internal/security"
    "github.com/CollaBoardUN/CollaBoard/authentication-module/internal/users"
)

func TestS4BaselineP2(t *testing.T) {
    repo := &fakeRepo{
        byEmail: map[string]users.User{},
    }

    app := New(
        repo,
        security.TokenService{
            Secret: []byte(strings.Repeat("x", 40)),
            TTL: time.Hour,
        },
        "http://localhost:5173",
    )

    registro := endpoint(
        app, "POST", "/auth/register",
        `{"name":"Prueba P2","email":"s4-p2@example.com","password":"Password-S4-2026!","confirm_password":"Password-S4-2026!"}`,
        nil,
    )

    if registro.Code != 201 {
        t.Fatalf("Registro: HTTP %d", registro.Code)
    }

    var sesion struct {
        AccessToken string `json:"access_token"`
        RefreshToken string `json:"refresh_token"`
    }

    if err := json.Unmarshal(registro.Body.Bytes(), &sesion); err != nil {
        t.Fatal(err)
    }

    partes := strings.Split(sesion.AccessToken, ".")
    if len(partes) != 3 {
        t.Fatal("JWT incorrecto")
    }

    datos, err := base64.RawURLEncoding.DecodeString(partes[1])
    if err != nil {
        t.Fatal(err)
    }

    var claims struct {
        Iat int64 `json:"iat"`
        Exp int64 `json:"exp"`
    }

    if err := json.Unmarshal(datos, &claims); err != nil {
        t.Fatal(err)
    }

    if claims.Exp-claims.Iat != 3600 {
        t.Fatalf("TTL inesperado: %d", claims.Exp-claims.Iat)
    }
    t.Log("OK: JWT P2 dura 3600 segundos")

    if sesion.RefreshToken != "" {
        t.Fatal("P2 entregó un refresh token")
    }
    t.Log("OK: P2 no entrega refresh token")

    headers := map[string]string{
        "Authorization": "Bearer " + sesion.AccessToken,
    }

    antes := endpoint(app, "GET", "/auth/me", "", headers)
    if antes.Code != 200 {
        t.Fatalf("JWT antes: HTTP %d", antes.Code)
    }
    t.Log("OK: JWT válido antes de logout")

    logout := endpoint(app, "POST", "/auth/logout", `{}`, headers)
    if logout.Code != 404 && logout.Code != 405 {
        t.Fatalf("Logout P2: HTTP %d", logout.Code)
    }
    t.Logf("OK: P2 no implementa logout servidor (HTTP %d)", logout.Code)

    despues := endpoint(app, "GET", "/auth/me", "", headers)
    if despues.Code != 200 {
        t.Fatalf("JWT después: HTTP %d", despues.Code)
    }
    t.Log("OK: JWT continúa válido después del intento de logout")
}
GO

echo "=== Reproducción del problema P2 (commit 6af0456) ==="

(
    cd "$temporal/authentication-module"
    go test -mod=mod -count=1 \
        -run '^TestS4BaselineP2$' \
        -v ./internal/httpapi
)
