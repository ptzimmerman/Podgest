-- Podgest D1 schema (migrated from Supabase Postgres, Jul 2026)
-- SQLite conventions: TEXT ISO-8601 timestamps, INTEGER 0/1 booleans, TEXT JSON blobs.

CREATE TABLE IF NOT EXISTS profiles (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  display_name TEXT,
  timezone TEXT NOT NULL DEFAULT 'America/Chicago',
  digest_time TEXT NOT NULL DEFAULT '06:00:00',
  digest_length_minutes INTEGER NOT NULL DEFAULT 5,
  dark_mode INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES profiles(id),
  feed_url TEXT NOT NULL,
  podcast_title TEXT,
  artwork_url TEXT,
  priority INTEGER NOT NULL DEFAULT 10,
  is_active INTEGER NOT NULL DEFAULT 1,
  publication_frequency_days REAL,
  last_polled_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_subscriptions_user ON subscriptions(user_id);

CREATE TABLE IF NOT EXISTS episodes (
  id TEXT PRIMARY KEY,
  feed_url TEXT NOT NULL,
  guid TEXT NOT NULL,
  title TEXT,
  description TEXT,
  audio_url TEXT,
  duration_seconds INTEGER,
  published_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_episodes_guid ON episodes(feed_url, guid);
CREATE INDEX IF NOT EXISTS idx_episodes_published ON episodes(published_at);

CREATE TABLE IF NOT EXISTS transcriptions (
  id TEXT PRIMARY KEY,
  episode_id TEXT NOT NULL REFERENCES episodes(id),
  status TEXT NOT NULL DEFAULT 'pending',
  transcript_storage_path TEXT,
  word_count INTEGER,
  language TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  processing_time_ms INTEGER,
  supermemory_doc_id TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_transcriptions_episode ON transcriptions(episode_id);
CREATE INDEX IF NOT EXISTS idx_transcriptions_status ON transcriptions(status);

CREATE TABLE IF NOT EXISTS topic_extractions (
  id TEXT PRIMARY KEY,
  transcription_id TEXT NOT NULL REFERENCES transcriptions(id),
  topics TEXT, -- JSON
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_topic_extractions_transcription ON topic_extractions(transcription_id);

CREATE TABLE IF NOT EXISTS digests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES profiles(id),
  digest_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  audio_url TEXT,
  audio_storage_path TEXT,
  script_text TEXT,
  script_storage_path TEXT,
  topic_clusters TEXT, -- JSON
  episodes_included TEXT, -- JSON array
  duration_seconds INTEGER,
  total_source_minutes INTEGER,
  processing_time_ms INTEGER,
  error_message TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_digests_user_date ON digests(user_id, digest_date);
CREATE INDEX IF NOT EXISTS idx_digests_status ON digests(status);

CREATE TABLE IF NOT EXISTS user_api_keys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE REFERENCES profiles(id),
  openai_key_encrypted TEXT,
  openai_valid INTEGER,
  openai_validated_at TEXT,
  anthropic_key_encrypted TEXT,
  anthropic_valid INTEGER,
  anthropic_validated_at TEXT,
  elevenlabs_key_encrypted TEXT,
  elevenlabs_valid INTEGER,
  elevenlabs_validated_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT
);

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

CREATE TABLE IF NOT EXISTS pipeline_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT,
  step TEXT NOT NULL,
  status TEXT NOT NULL,
  details TEXT, -- JSON
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_pipeline_logs_run ON pipeline_logs(run_id);
CREATE INDEX IF NOT EXISTS idx_pipeline_logs_created ON pipeline_logs(created_at);

-- Chunk text + metadata live here; the 1536-dim vectors live in Vectorize
-- (Vectorize vector id == this table's id).
CREATE TABLE IF NOT EXISTS transcript_chunks (
  id TEXT PRIMARY KEY,
  episode_id TEXT NOT NULL REFERENCES episodes(id),
  user_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  chunk_text TEXT NOT NULL,
  word_count INTEGER,
  metadata TEXT, -- JSON
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_chunks_episode ON transcript_chunks(episode_id);
CREATE INDEX IF NOT EXISTS idx_chunks_user ON transcript_chunks(user_id);

-- Snapshot of Supabase auth users, used to map identities into Better Auth (Phase 5)
CREATE TABLE IF NOT EXISTS legacy_auth_users (
  id TEXT PRIMARY KEY,
  email TEXT,
  provider TEXT,
  provider_id TEXT,
  raw_user_meta_data TEXT, -- JSON
  created_at TEXT,
  last_sign_in_at TEXT
);

-- MCP memory layer (Phase 6): text + metadata here, vectors in Vectorize
-- under the "memories" metadata namespace, exempt from pruning.
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  namespace TEXT NOT NULL DEFAULT 'general', -- e.g. 'podcasts', 'trading'
  content TEXT NOT NULL,
  metadata TEXT, -- JSON
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_memories_user_ns ON memories(user_id, namespace);
