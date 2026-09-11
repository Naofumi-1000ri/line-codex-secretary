CREATE TABLE IF NOT EXISTS job_media (
  job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL,
  metadata_json TEXT NOT NULL
);
INSERT OR IGNORE INTO schema_versions(version, applied_at) VALUES (2, datetime('now'));
