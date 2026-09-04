PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_versions (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

INSERT OR IGNORE INTO schema_versions(version, applied_at)
VALUES (1, datetime('now'));

CREATE TABLE IF NOT EXISTS owners (
  user_id TEXT PRIMARY KEY,
  linked_at TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
);

CREATE TABLE IF NOT EXISTS link_codes (
  code_hash TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS line_events (
  webhook_event_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  received_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  webhook_event_id TEXT UNIQUE NOT NULL,
  user_id TEXT NOT NULL,
  conversation_key TEXT NOT NULL,
  workspace_key TEXT NOT NULL,
  prompt TEXT,
  result TEXT,
  requested_mode TEXT NOT NULL DEFAULT 'read_only' CHECK (requested_mode = 'read_only'),
  status TEXT NOT NULL CHECK (status IN ('QUEUED','LEASED','RUNNING','WAITING_APPROVAL','RETRY_WAIT','CANCEL_REQUESTED','CANCELLED','COMPLETED','FAILED')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  lease_token_hash TEXT,
  lease_expires_at TEXT,
  codex_thread_id TEXT,
  cancel_requested_at TEXT,
  error_code TEXT,
  notification_status TEXT NOT NULL DEFAULT 'PENDING',
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_jobs_status_created ON jobs(status, created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_conversation_status ON jobs(conversation_key, status);
CREATE INDEX IF NOT EXISTS idx_jobs_lease_expires ON jobs(lease_expires_at);

CREATE TABLE IF NOT EXISTS job_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  public_message TEXT,
  idempotency_key TEXT UNIQUE NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agents (
  agent_id TEXT PRIMARY KEY,
  last_seen_at TEXT NOT NULL,
  version TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  job_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
