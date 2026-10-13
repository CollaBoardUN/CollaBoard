package users

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
)

var ErrEmailTaken = errors.New("correo ya registrado")

type User struct {
	ID           string    `json:"id"`
	Name         string    `json:"name"`
	Email        string    `json:"email"`
	PasswordHash string    `json:"-"`
	CreatedAt    time.Time `json:"created_at"`
}

type Repository interface {
	Create(context.Context, string, string, string) (User, error)
	ByEmail(context.Context, string) (User, error)
	ByID(context.Context, string) (User, error)
}

type PostgresRepository struct{ DB *sql.DB }

func (r PostgresRepository) Create(ctx context.Context, name, email, hash string) (User, error) {
	u := User{Name: name, Email: email, PasswordHash: hash}
	err := r.DB.QueryRowContext(ctx,
		`INSERT INTO auth.users (name,email,password_hash) VALUES ($1,$2,$3) RETURNING id::text,created_at`,
		name, email, hash).Scan(&u.ID, &u.CreatedAt)
	if err != nil {
		var pg *pgconn.PgError
		if errors.As(err, &pg) && pg.Code == "23505" {
			return User{}, ErrEmailTaken
		}
		return User{}, err
	}
	return u, nil
}
func (r PostgresRepository) ByEmail(ctx context.Context, email string) (User, error) {
	return scanUser(r.DB.QueryRowContext(ctx,
		`SELECT id::text,name,email,password_hash,created_at FROM auth.users WHERE email=$1`, email))
}
func (r PostgresRepository) ByID(ctx context.Context, id string) (User, error) {
	return scanUser(r.DB.QueryRowContext(ctx,
		`SELECT id::text,name,email,password_hash,created_at FROM auth.users WHERE id::text=$1`, id))
}
func scanUser(row *sql.Row) (User, error) {
	var u User
	err := row.Scan(&u.ID, &u.Name, &u.Email, &u.PasswordHash, &u.CreatedAt)
	return u, err
}
