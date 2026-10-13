package security

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"

	"golang.org/x/crypto/argon2"
)

// Parámetros Argon2id adecuados para el prototipo local. Ajustar con benchmarks
// y límites de memoria antes de escalar horizontalmente.
const (
	memory      uint32 = 64 * 1024 // KiB
	iterations  uint32 = 3
	parallelism uint8  = 2
	keyLength   uint32 = 32
	saltLength         = 16
)

func HashPassword(password string) (string, error) {
	salt := make([]byte, saltLength)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	key := argon2.IDKey([]byte(password), salt, iterations, memory, parallelism, keyLength)
	return fmt.Sprintf("$argon2id$v=19$m=%d,t=%d,p=%d$%s$%s", memory, iterations, parallelism,
		base64.RawStdEncoding.EncodeToString(salt), base64.RawStdEncoding.EncodeToString(key)), nil
}

func CheckPassword(encoded, password string) bool {
	var m, t uint32
	var p uint8
	parts := strings.Split(encoded, "$")
	if len(parts) != 6 || parts[1] != "argon2id" || parts[2] != "v=19" {
		return false
	}
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &m, &t, &p); err != nil {
		return false
	}
	// No permitir parámetros arbitrarios provenientes de la base de datos.
	if m != memory || t != iterations || p != parallelism {
		return false
	}
	salt, err1 := base64.RawStdEncoding.DecodeString(parts[4])
	hash, err2 := base64.RawStdEncoding.DecodeString(parts[5])
	if errors.Join(err1, err2) != nil || len(salt) != saltLength || len(hash) != int(keyLength) {
		return false
	}
	actual := argon2.IDKey([]byte(password), salt, t, m, p, uint32(len(hash)))
	return subtle.ConstantTimeCompare(actual, hash) == 1
}
