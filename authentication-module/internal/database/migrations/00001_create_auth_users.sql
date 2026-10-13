-- +goose Up
CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE IF NOT EXISTS auth.users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(120) NOT NULL,
  email VARCHAR(255) NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT auth_users_email_lowercase CHECK (email = LOWER(email))
);
CREATE UNIQUE INDEX IF NOT EXISTS auth_users_email_unique ON auth.users (email);

-- +goose Down
DROP TABLE IF EXISTS auth.users;
DROP SCHEMA IF EXISTS auth;
