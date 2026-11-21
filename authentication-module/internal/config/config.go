package config

import (
	"errors"
	"os"
	"strings"
	"time"
)

type Config struct {
	Port        string
	DatabaseURL string
	JWTSecret   string
	FrontendURL string
	TokenTTL    time.Duration
	RefreshTTL  time.Duration
}

func Load() (Config, error) {
	dbURL := os.Getenv("USER_DATABASE_URL")
	if dbURL == "" {
		dbURL = os.Getenv("AUTH_DATABASE_URL")
	}
	c := Config{
		Port:        env("AUTH_PORT", "8001"),
		DatabaseURL: dbURL,
		JWTSecret:   os.Getenv("JWT_SECRET"),
		FrontendURL: strings.TrimRight(env("FRONTEND_URL", "http://localhost:8088"), "/"),
		TokenTTL:    15 * time.Minute,
		RefreshTTL: 7 * 24 * time.Hour,
	}
	var err error
	c.TokenTTL, err = time.ParseDuration(env("JWT_ACCESS_TTL", "15m"))
	if err != nil || c.TokenTTL <= 0 || c.TokenTTL > 15*time.Minute {
		return c, errors.New("JWT_ACCESS_TTL debe ser una duración entre 1ns y 15m")
	}
	c.RefreshTTL, err = time.ParseDuration(env("JWT_REFRESH_TTL", "168h"))
	if err != nil || c.RefreshTTL <= 0 || c.RefreshTTL > 30*24*time.Hour {
		return c, errors.New("JWT_REFRESH_TTL debe ser positiva y máximo 720h")
	}
	if c.DatabaseURL == "" {
		return c, errors.New("USER_DATABASE_URL o AUTH_DATABASE_URL es obligatorio")
	}
	if len(c.JWTSecret) < 32 {
		return c, errors.New("JWT_SECRET debe contener al menos 32 bytes")
	}
	if !strings.HasPrefix(c.FrontendURL, "http://") && !strings.HasPrefix(c.FrontendURL, "https://") {
		return c, errors.New("FRONTEND_URL debe empezar con http:// o https://")
	}
	return c, nil
}

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
