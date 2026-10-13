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
}

func Load() (Config, error) {
	c := Config{
		Port:        env("AUTH_PORT", "8001"),
		DatabaseURL: os.Getenv("AUTH_DATABASE_URL"),
		JWTSecret:   os.Getenv("JWT_SECRET"),
		FrontendURL: strings.TrimRight(env("FRONTEND_URL", "http://localhost:5173"), "/"),
		TokenTTL:    time.Hour,
	}
	if c.DatabaseURL == "" {
		return c, errors.New("AUTH_DATABASE_URL es obligatorio")
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
