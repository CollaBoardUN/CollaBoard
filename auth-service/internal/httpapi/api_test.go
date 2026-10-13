package httpapi

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/CollaBoardUN/CollaBoard/auth-service/internal/security"
	"github.com/CollaBoardUN/CollaBoard/auth-service/internal/users"
)

type fakeRepo struct{ byEmail map[string]users.User }

func (f *fakeRepo) Create(_ context.Context, name, email, hash string) (users.User, error) {
	if _, found := f.byEmail[email]; found {
		return users.User{}, users.ErrEmailTaken
	}
	u := users.User{ID: fmt.Sprintf("user-%d", len(f.byEmail)+1), Name: name, Email: email, PasswordHash: hash, CreatedAt: time.Now()}
	f.byEmail[email] = u
	return u, nil
}
func (f *fakeRepo) ByEmail(_ context.Context, email string) (users.User, error) {
	u, ok := f.byEmail[email]
	if !ok {
		return u, sql.ErrNoRows
	}
	return u, nil
}
func (f *fakeRepo) ByID(_ context.Context, id string) (users.User, error) {
	for _, u := range f.byEmail {
		if u.ID == id {
			return u, nil
		}
	}
	return users.User{}, sql.ErrNoRows
}
func endpoint(h http.Handler, method, path, body string, headers map[string]string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, bytes.NewBufferString(body))
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	return w
}
func TestRegisterLoginAndMe(t *testing.T) {
	f := &fakeRepo{byEmail: map[string]users.User{}}
	app := New(f, security.TokenService{Secret: []byte(strings.Repeat("x", 40)), TTL: time.Hour}, "http://localhost:5173")
	body := `{"name":"Ana Gómez","email":"Ana@Example.com","password":"muy-segura-123456","confirm_password":"muy-segura-123456"}`
	r := endpoint(app, "POST", "/auth/register", body, nil)
	if r.Code != 201 {
		t.Fatalf("register %d %s", r.Code, r.Body.String())
	}
	var output struct {
		AccessToken string     `json:"access_token"`
		User        users.User `json:"user"`
	}
	if err := json.Unmarshal(r.Body.Bytes(), &output); err != nil {
		t.Fatal(err)
	}
	if output.User.Email != "ana@example.com" || output.AccessToken == "" {
		t.Fatalf("register respuesta %+v", output)
	}
	if strings.Contains(r.Body.String(), "password_hash") {
		t.Fatal("el hash se filtró en JSON")
	}
	duplicate := endpoint(app, "POST", "/auth/register", body, nil)
	if duplicate.Code != 409 {
		t.Fatalf("duplicate status %d", duplicate.Code)
	}
	login := endpoint(app, "POST", "/auth/login", `{"email":"ANA@example.com","password":"muy-segura-123456"}`, nil)
	if login.Code != 200 {
		t.Fatalf("login %d %s", login.Code, login.Body.String())
	}
	me := endpoint(app, "GET", "/auth/me", "", map[string]string{"Authorization": "Bearer " + output.AccessToken})
	if me.Code != 200 || !strings.Contains(me.Body.String(), "Ana Gómez") {
		t.Fatalf("me %d %s", me.Code, me.Body.String())
	}
	bad := endpoint(app, "POST", "/auth/login", `{"email":"ana@example.com","password":"mal"}`, nil)
	if bad.Code != 401 {
		t.Fatalf("password mala status %d", bad.Code)
	}
	wrongOrigin := endpoint(app, "POST", "/auth/login", `{}`, map[string]string{"Origin": "https://evil.test"})
	if wrongOrigin.Code != 403 {
		t.Fatalf("cors %d", wrongOrigin.Code)
	}
}
func TestValidation(t *testing.T) {
	f := &fakeRepo{byEmail: map[string]users.User{}}
	app := New(f, security.TokenService{Secret: []byte(strings.Repeat("x", 40)), TTL: time.Hour}, "http://localhost:5173")
	cases := []struct {
		body   string
		status int
	}{
		{`{"name":"A","email":"ana@example.com","password":"mi-password-largo","confirm_password":"mi-password-largo"}`, 422},
		{`{"name":"Ana","email":"mal","password":"mi-password-largo","confirm_password":"mi-password-largo"}`, 422},
		{`{"name":"Ana","email":"ana@example.com","password":"mi-password-largo","confirm_password":"otra"}`, 422},
		{`{"name":"Ana","email":"ana@example.com","password":"corta","confirm_password":"corta"}`, 422},
		{`{"name":"Ana","email":"ana@example.com","password":"mi-password-largo","confirm_password":"mi-password-largo","admin":true}`, 400},
	}
	for _, tc := range cases {
		r := endpoint(app, "POST", "/auth/register", tc.body, nil)
		if r.Code != tc.status {
			t.Errorf("caso status %d esperado %d: %s", r.Code, tc.status, tc.body)
		}
	}
	if _, err := f.ByEmail(context.Background(), "ana@example.com"); !errors.Is(err, sql.ErrNoRows) {
		t.Fatal("se insertó usuario inválido")
	}
}
