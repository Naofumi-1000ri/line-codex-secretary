CREATE TABLE IF NOT EXISTS conversation_preferences (
  conversation_key TEXT PRIMARY KEY,
  notification_mode TEXT NOT NULL DEFAULT 'quiet' CHECK (notification_mode IN ('quiet','detailed'))
);
ALTER TABLE jobs ADD COLUMN notification_mode TEXT NOT NULL DEFAULT 'quiet';
INSERT OR IGNORE INTO schema_versions(version, applied_at) VALUES (3, datetime('now'));
