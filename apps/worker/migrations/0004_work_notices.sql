ALTER TABLE jobs ADD COLUMN notice_group TEXT;
CREATE INDEX IF NOT EXISTS idx_jobs_notice_group ON jobs(notice_group);
INSERT OR IGNORE INTO schema_versions(version, applied_at) VALUES (4, datetime('now'));
