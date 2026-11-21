package security

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"time"
)

var ErrInvalidRefresh = errors.New("refresh token inválido, vencido o revocado")

// RefreshSessions permite sustituir PostgreSQL por una implementación falsa en las pruebas.
type RefreshSessions interface {
	Create(ctx context.Context, userID, userAgent string) (string, error)
	Rotate(ctx context.Context, raw, userAgent string) (userID, newRaw string, err error)
	Revoke(ctx context.Context, raw string) error
}

// RefreshStore conserva únicamente SHA-256 de tokens opacos de 256 bits.
// El bloqueo FOR UPDATE serializa los refresh concurrentes del mismo token.
type RefreshStore struct {
	DB  *sql.DB
	TTL time.Duration
}

func newSecret() (string, []byte, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", nil, err
	}
	raw := base64.RawURLEncoding.EncodeToString(b)
	h := sha256.Sum256([]byte(raw))
	return raw, h[:], nil
}

func newUUID() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	h := hex.EncodeToString(b)
	return fmt.Sprintf("%s-%s-%s-%s-%s", h[:8], h[8:12], h[12:16], h[16:20], h[20:]), nil
}

func (s RefreshStore) ttl() time.Duration {
	if s.TTL > 0 {
		return s.TTL
	}
	return 7 * 24 * time.Hour
}

func clippedUA(ua string) string {
	if len(ua) > 256 {
		ua = ua[:256]
	}
	return ua
}

func (s RefreshStore) Create(ctx context.Context, userID, userAgent string) (string, error) {
	id, err := newUUID()
	if err != nil {
		return "", err
	}
	family, err := newUUID()
	if err != nil {
		return "", err
	}
	raw, hash, err := newSecret()
	if err != nil {
		return "", err
	}
	_, err = s.DB.ExecContext(ctx, `INSERT INTO auth.refresh_tokens
      (id,user_id,family_id,token_hash,expires_at,user_agent)
      VALUES ($1,$2,$3,$4,$5,$6)`, id, userID, family, hash, time.Now().UTC().Add(s.ttl()), clippedUA(userAgent))
	if err != nil {
		return "", err
	}
	return raw, nil
}

// Rotate bloquea la fila del token usado y hace la sustitución en una transacción.
// Si detecta reutilización, revoca la familia entera y confirma esa revocación.
func (s RefreshStore) Rotate(ctx context.Context, raw, userAgent string) (string, string, error) {
	if len(raw) != 43 {
		return "", "", ErrInvalidRefresh
	}
	hash := sha256.Sum256([]byte(raw))
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return "", "", err
	}
	defer tx.Rollback()

	var id, userID, familyID string
	var expiry time.Time
	var revoked sql.NullTime
	err = tx.QueryRowContext(ctx, `SELECT id::text,user_id::text,family_id::text,expires_at,revoked_at
      FROM auth.refresh_tokens WHERE token_hash=$1 FOR UPDATE`, hash[:]).Scan(&id, &userID, &familyID, &expiry, &revoked)
	if errors.Is(err, sql.ErrNoRows) {
		return "", "", ErrInvalidRefresh
	}
	if err != nil {
		return "", "", err
	}

	if revoked.Valid {
		_, err = tx.ExecContext(ctx, `UPDATE auth.refresh_tokens
          SET revoked_at=COALESCE(revoked_at,now()) WHERE family_id=$1`, familyID)
		if err != nil {
			return "", "", err
		}
		if err = tx.Commit(); err != nil {
			return "", "", err
		}
		return "", "", ErrInvalidRefresh
	}
	if !expiry.After(time.Now().UTC()) {
		return "", "", ErrInvalidRefresh
	}

	nextID, err := newUUID()
	if err != nil {
		return "", "", err
	}
	nextRaw, nextHash, err := newSecret()
	if err != nil {
		return "", "", err
	}
	_, err = tx.ExecContext(ctx, `UPDATE auth.refresh_tokens
      SET revoked_at=now(), replaced_by=$1 WHERE id=$2 AND revoked_at IS NULL`, nextID, id)
	if err != nil {
		return "", "", err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO auth.refresh_tokens
      (id,user_id,family_id,token_hash,expires_at,user_agent)
      VALUES ($1,$2,$3,$4,$5,$6)`, nextID, userID, familyID, nextHash, time.Now().UTC().Add(s.ttl()), clippedUA(userAgent))
	if err != nil {
		return "", "", err
	}
	if err = tx.Commit(); err != nil {
		return "", "", err
	}
	return userID, nextRaw, nil
}

// Revoke termina todas las credenciales de renovación de una misma sesión.
// Desconocer el token es un error de autenticación, no de infraestructura.
func (s RefreshStore) Revoke(ctx context.Context, raw string) error {
	if len(raw) != 43 {
		return ErrInvalidRefresh
	}
	hash := sha256.Sum256([]byte(raw))
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var family string
	err = tx.QueryRowContext(ctx, `SELECT family_id::text FROM auth.refresh_tokens
      WHERE token_hash=$1 FOR UPDATE`, hash[:]).Scan(&family)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrInvalidRefresh
	}
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `UPDATE auth.refresh_tokens
      SET revoked_at=COALESCE(revoked_at,now()) WHERE family_id=$1`, family)
	if err != nil {
		return err
	}
	return tx.Commit()
}
