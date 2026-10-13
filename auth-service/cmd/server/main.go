package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/CollaBoardUN/CollaBoard/auth-service/internal/config"
	"github.com/CollaBoardUN/CollaBoard/auth-service/internal/database"
	"github.com/CollaBoardUN/CollaBoard/auth-service/internal/httpapi"
	"github.com/CollaBoardUN/CollaBoard/auth-service/internal/security"
	"github.com/CollaBoardUN/CollaBoard/auth-service/internal/users"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		log.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	db, err := database.Open(ctx, cfg.DatabaseURL)
	cancel()
	if err != nil {
		log.Fatal(err)
	}
	defer db.Close()
	repo := users.PostgresRepository{DB: db}
	tokens := security.TokenService{Secret: []byte(cfg.JWTSecret), TTL: cfg.TokenTTL}
	server := &http.Server{Addr: ":" + cfg.Port, Handler: httpapi.New(repo, tokens, cfg.FrontendURL), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 30 * time.Second, IdleTimeout: 60 * time.Second}
	stop, shutdown := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer shutdown()
	go func() {
		<-stop.Done()
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = server.Shutdown(ctx)
	}()
	log.Printf("auth-service escuchando en :%s", cfg.Port)
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}
