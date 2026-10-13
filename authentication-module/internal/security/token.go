package security

import (
	"errors"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

const issuer = "collaboard-auth"

type Claims struct {
	Name  string `json:"name"`
	Email string `json:"email"`
	jwt.RegisteredClaims
}

type TokenService struct {
	Secret []byte
	TTL    time.Duration
}

func (s TokenService) Issue(id, name, email string) (string, error) {
	now := time.Now().UTC()
	claims := Claims{Name: name, Email: email, RegisteredClaims: jwt.RegisteredClaims{
		Subject: id, Issuer: issuer, IssuedAt: jwt.NewNumericDate(now), ExpiresAt: jwt.NewNumericDate(now.Add(s.TTL)),
	}}
	return jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString(s.Secret)
}
func (s TokenService) Verify(raw string) (*Claims, error) {
	claims := &Claims{}
	token, err := jwt.ParseWithClaims(raw, claims, func(token *jwt.Token) (any, error) { return s.Secret, nil },
		jwt.WithValidMethods([]string{jwt.SigningMethodHS256.Alg()}), jwt.WithIssuer(issuer), jwt.WithExpirationRequired())
	if err != nil || !token.Valid || claims.Subject == "" {
		return nil, errors.New("token inválido o expirado")
	}
	return claims, nil
}
