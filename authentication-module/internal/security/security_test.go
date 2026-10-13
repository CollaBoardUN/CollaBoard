package security

import (
	"strings"
	"testing"
	"time"
)

func TestPasswordHashAndVerify(t *testing.T) {
	hash, err := HashPassword("mi-password-larga-123")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(hash, "mi-password") || !strings.HasPrefix(hash, "$argon2id$") {
		t.Fatal("hash incorrecto")
	}
	if !CheckPassword(hash, "mi-password-larga-123") {
		t.Fatal("contraseña correcta rechazada")
	}
	if CheckPassword(hash, "otra") || CheckPassword("hash-malformado", "otra") {
		t.Fatal("contraseña incorrecta aceptada")
	}
}
func TestJWTCompatible(t *testing.T) {
	s := TokenService{Secret: []byte(strings.Repeat("a", 40)), TTL: time.Hour}
	raw, err := s.Issue("550e8400-e29b-41d4-a716-446655440000", "Ana", "ana@ejemplo.com")
	if err != nil {
		t.Fatal(err)
	}
	c, err := s.Verify(raw)
	if err != nil || c.Subject == "" || c.Name != "Ana" {
		t.Fatalf("token inválido %v", err)
	}
	other := TokenService{Secret: []byte(strings.Repeat("b", 40)), TTL: time.Hour}
	if _, err := other.Verify(raw); err == nil {
		t.Fatal("aceptó firma con clave equivocada")
	}
}
