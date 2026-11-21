-- +goose Up
CREATE TABLE IF NOT EXISTS auth.refresh_tokens (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  family_id UUID NOT NULL,
  token_hash BYTEA NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  replaced_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_agent VARCHAR(256) NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_family ON auth.refresh_tokens(family_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON auth.refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expiry ON auth.refresh_tokens(expires_at);
-- +goose Down
DROP TABLE IF EXISTS auth.refresh_tokens;
