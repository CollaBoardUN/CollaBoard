package httpapi

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/CollaBoardUN/CollaBoard/authentication-module/internal/security"
	"github.com/CollaBoardUN/CollaBoard/authentication-module/internal/users"
)

type fakeRefresh struct {
	owner   string
	active  string
	spent   string
	revoked bool
}

func (f *fakeRefresh) Create(_ context.Context, userID, _ string) (string, error) {
	f.owner = userID
	f.active = "initial-token"
	return f.active, nil
}
func (f *fakeRefresh) Rotate(_ context.Context, raw, _ string) (string, string, error) {
	if raw == f.spent && raw != "" {
		f.revoked = true
		return "", "", security.ErrInvalidRefresh
	}
	if f.revoked || raw != f.active {
		return "", "", security.ErrInvalidRefresh
	}
	f.spent = raw
	f.active = "replacement-token"
	return f.owner, f.active, nil
}
func (f *fakeRefresh) Revoke(_ context.Context, raw string) error {
	if raw != f.active {
		return security.ErrInvalidRefresh
	}
	f.revoked = true
	return nil
}
func TestRefreshRotationAndLogoutRoutes(t *testing.T) {
	repo := &fakeRepo{byEmail: map[string]users.User{}}
	sessions := &fakeRefresh{}
	tokens := security.TokenService{Secret: []byte(strings.Repeat("k", 40)), TTL: 15 * time.Minute}
	app := New(repo, tokens, "http://localhost:5173", sessions)
	registered := endpoint(app, "POST", "/auth/register", `{"name":"Test User","email":"test@example.com","password":"password-valida-2026","confirm_password":"password-valida-2026"}`, nil)
	if registered.Code != 201 {
		t.Fatalf("register: %d %s", registered.Code, registered.Body.String())
	}
	var initial session
	if err := json.Unmarshal(registered.Body.Bytes(), &initial); err != nil {
		t.Fatal(err)
	}
	if initial.RefreshToken == "" {
		t.Fatal("faltó refresh")
	}
	rotated := endpoint(app, "POST", "/auth/refresh", `{"refresh_token":"initial-token"}`, nil)
	if rotated.Code != 200 {
		t.Fatalf("refresh: %d %s", rotated.Code, rotated.Body.String())
	}
	var next session
	if err := json.Unmarshal(rotated.Body.Bytes(), &next); err != nil {
		t.Fatal(err)
	}
	if next.RefreshToken == initial.RefreshToken || next.AccessToken == initial.AccessToken {
		t.Fatal("no rotó credenciales")
	}
	replay := endpoint(app, "POST", "/auth/refresh", `{"refresh_token":"initial-token"}`, nil)
	if replay.Code != 401 {
		t.Fatalf("replay: %d", replay.Code)
	}
	blocked := endpoint(app, "POST", "/auth/refresh", `{"refresh_token":"replacement-token"}`, nil)
	if blocked.Code != 401 {
		t.Fatalf("familia activa después de replay: %d", blocked.Code)
	}
}
