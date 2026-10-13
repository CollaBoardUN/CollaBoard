package httpapi

import (
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/mail"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/CollaBoardUN/CollaBoard/authentication-module/internal/security"
	"github.com/CollaBoardUN/CollaBoard/authentication-module/internal/users"
	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
)

type api struct {
	repo   users.Repository
	tokens security.TokenService
	limits *loginLimiter
}

type credentials struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}
type registration struct {
	Name            string `json:"name"`
	Email           string `json:"email"`
	Password        string `json:"password"`
	ConfirmPassword string `json:"confirm_password"`
}
type session struct {
	AccessToken string     `json:"access_token"`
	TokenType   string     `json:"token_type"`
	User        users.User `json:"user"`
}

func New(repo users.Repository, tokens security.TokenService, frontendURL string) http.Handler {
	a := &api{repo: repo, tokens: tokens, limits: newLoginLimiter()}
	router := chi.NewRouter()
	router.Use(middleware.Recoverer)
	router.Use(middleware.RequestID)
	router.Use(middleware.StripSlashes)
	router.Use(cors(frontendURL))
	router.Get("/health", func(w http.ResponseWriter, _ *http.Request) { writeJSON(w, 200, map[string]string{"status": "ok"}) })
	router.Post("/auth/register", a.register)
	router.Post("/auth/login", a.login)
	router.Get("/auth/me", a.me)
	router.NotFound(func(w http.ResponseWriter, _ *http.Request) { fail(w, 404, "Ruta no encontrada") })
	router.MethodNotAllowed(func(w http.ResponseWriter, _ *http.Request) { fail(w, 405, "Método no permitido") })
	return router
}

func cors(allowed string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			origin := r.Header.Get("Origin")
			if origin != "" {
				w.Header().Add("Vary", "Origin")
				if origin != allowed {
					fail(w, 403, "Origen no permitido")
					return
				}
				w.Header().Set("Access-Control-Allow-Origin", allowed)
				w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
				w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
				w.Header().Set("Access-Control-Max-Age", "600")
			}
			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusNoContent)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

func decode(w http.ResponseWriter, r *http.Request, out any) bool {
	if !strings.HasPrefix(strings.ToLower(r.Header.Get("Content-Type")), "application/json") {
		fail(w, 415, "Envía el contenido como application/json")
		return false
	}
	r.Body = http.MaxBytesReader(w, r.Body, 16*1024)
	d := json.NewDecoder(r.Body)
	d.DisallowUnknownFields()
	if err := d.Decode(out); err != nil {
		fail(w, 400, "JSON inválido o demasiado grande")
		return false
	}
	var trailing any
	if err := d.Decode(&trailing); !errors.Is(err, io.EOF) {
		fail(w, 400, "El cuerpo debe contener un solo objeto JSON")
		return false
	}
	return true
}

func normalizeEmail(email string) (string, bool) {
	email = strings.ToLower(strings.TrimSpace(email))
	if len(email) > 255 || email == "" || strings.ContainsAny(email, "\r\n\t ") {
		return "", false
	}
	parsed, err := mail.ParseAddress(email)
	if err != nil || parsed.Address != email || parsed.Name != "" {
		return "", false
	}
	at := strings.LastIndexByte(email, '@')
	if at < 1 || !strings.Contains(email[at+1:], ".") || strings.HasSuffix(email, ".") {
		return "", false
	}
	return email, true
}

func (a *api) register(w http.ResponseWriter, r *http.Request) {
	var req registration
	if !decode(w, r, &req) {
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if !utf8.ValidString(req.Name) || utf8.RuneCountInString(req.Name) < 2 || utf8.RuneCountInString(req.Name) > 120 {
		fail(w, 422, "El nombre debe tener entre 2 y 120 caracteres")
		return
	}
	email, valid := normalizeEmail(req.Email)
	if !valid {
		fail(w, 422, "Introduce un correo electrónico válido")
		return
	}
	if req.Password != req.ConfirmPassword {
		fail(w, 422, "Las contraseñas no coinciden")
		return
	}
	if len(req.Password) < 12 || len(req.Password) > 128 || !utf8.ValidString(req.Password) {
		fail(w, 422, "La contraseña debe tener entre 12 y 128 bytes")
		return
	}
	hash, err := security.HashPassword(req.Password)
	if err != nil {
		fail(w, 500, "No fue posible completar el registro")
		return
	}
	user, err := a.repo.Create(r.Context(), req.Name, email, hash)
	if errors.Is(err, users.ErrEmailTaken) {
		fail(w, 409, "El correo ya está registrado")
		return
	}
	if err != nil {
		fail(w, 500, "No fue posible completar el registro")
		return
	}
	a.respondSession(w, http.StatusCreated, user)
}

func (a *api) login(w http.ResponseWriter, r *http.Request) {
	var req credentials
	if !decode(w, r, &req) {
		return
	}
	email, valid := normalizeEmail(req.Email)
	if !valid || req.Password == "" {
		fail(w, 401, "Correo o contraseña incorrectos")
		return
	}
	ip, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		ip = r.RemoteAddr
	}
	if !a.limits.Allow(ip + "|" + email) {
		w.Header().Set("Retry-After", "900")
		fail(w, 429, "Demasiados intentos. Intenta más tarde")
		return
	}
	user, err := a.repo.ByEmail(r.Context(), email)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		fail(w, 500, "No fue posible iniciar sesión")
		return
	}
	if err != nil || !security.CheckPassword(user.PasswordHash, req.Password) {
		fail(w, 401, "Correo o contraseña incorrectos")
		return
	}
	a.limits.Reset(ip + "|" + email)
	a.respondSession(w, 200, user)
}
func (a *api) respondSession(w http.ResponseWriter, status int, u users.User) {
	token, err := a.tokens.Issue(u.ID, u.Name, u.Email)
	if err != nil {
		fail(w, 500, "No fue posible crear la sesión")
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, status, session{AccessToken: token, TokenType: "bearer", User: u})
}
func (a *api) me(w http.ResponseWriter, r *http.Request) {
	auth := strings.Fields(r.Header.Get("Authorization"))
	if len(auth) != 2 || !strings.EqualFold(auth[0], "Bearer") {
		unauthorized(w)
		return
	}
	claims, err := a.tokens.Verify(auth[1])
	if err != nil {
		unauthorized(w)
		return
	}
	user, err := a.repo.ByID(r.Context(), claims.Subject)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			unauthorized(w)
		} else {
			fail(w, 500, "No fue posible consultar el usuario")
		}
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, 200, user)
}
func unauthorized(w http.ResponseWriter) {
	w.Header().Set("WWW-Authenticate", "Bearer")
	fail(w, 401, "No autenticado")
}
func fail(w http.ResponseWriter, status int, detail string) {
	writeJSON(w, status, map[string]string{"detail": detail})
}
func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

// Limitador local por combinación IP + correo; suficiente para un único contenedor
// en la demo, pero debe sustituirse por un limitador compartido al escalar.
type loginLimiter struct {
	mu    sync.Mutex
	items map[string]attempts
}
type attempts struct {
	count int
	since time.Time
}

func newLoginLimiter() *loginLimiter { return &loginLimiter{items: map[string]attempts{}} }
func (l *loginLimiter) Allow(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	entry := l.items[key]
	if now.Sub(entry.since) > 15*time.Minute {
		entry = attempts{since: now}
	}
	if entry.count >= 10 {
		return false
	}
	entry.count++
	l.items[key] = entry
	if len(l.items) > 10000 {
		for k, v := range l.items {
			if now.Sub(v.since) > 15*time.Minute {
				delete(l.items, k)
			}
		}
	}
	return true
}
func (l *loginLimiter) Reset(key string) { l.mu.Lock(); defer l.mu.Unlock(); delete(l.items, key) }
