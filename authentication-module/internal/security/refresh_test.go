package security

import (
	"crypto/sha256"
	"encoding/base64"
	"testing"
)

func TestRefreshSecretsAreRandomAnd256Bits(t *testing.T) {
	a, ha, err := newSecret()
	if err != nil {
		t.Fatal(err)
	}
	b, hb, err := newSecret()
	if err != nil {
		t.Fatal(err)
	}
	if a == b || string(ha) == string(hb) {
		t.Fatal("tokens repetidos")
	}
	decoded, err := base64.RawURLEncoding.DecodeString(a)
	if err != nil || len(decoded) != 32 {
		t.Fatalf("secreto no tiene 256 bits: %v", err)
	}
	want := sha256.Sum256([]byte(a))
	if string(ha) != string(want[:]) {
		t.Fatal("hash SHA-256 inválido")
	}
}

func TestRefreshUUIDsAreUnique(t *testing.T) {
	a, err := newUUID()
	if err != nil {
		t.Fatal(err)
	}
	b, err := newUUID()
	if err != nil {
		t.Fatal(err)
	}
	if a == b || len(a) != 36 || len(b) != 36 {
		t.Fatal("UUID incorrecto")
	}
}
