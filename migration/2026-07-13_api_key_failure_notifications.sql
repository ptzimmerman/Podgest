CREATE TABLE IF NOT EXISTS api_key_failure_notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES profiles(id),
  provider TEXT NOT NULL CHECK (provider IN ('openai', 'anthropic')),
  key_validated_at TEXT NOT NULL,
  first_failed_at TEXT NOT NULL,
  reason TEXT NOT NULL,
  email_status TEXT NOT NULL CHECK (
    email_status IN ('sending', 'sent', 'failed')
  ),
  email_sent_at TEXT,
  email_error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (user_id, provider, key_validated_at, first_failed_at)
);

CREATE INDEX IF NOT EXISTS idx_api_key_failure_notifications_user
  ON api_key_failure_notifications(user_id, provider, created_at);
