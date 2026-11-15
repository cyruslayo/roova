ALTER TABLE generation_jobs ADD COLUMN pending_version_id TEXT;
ALTER TABLE generation_jobs ADD COLUMN cost_json TEXT;
ALTER TABLE generation_jobs ADD COLUMN transcoded INTEGER;
CREATE TABLE job_assets (
  job_id TEXT NOT NULL REFERENCES generation_jobs(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  r2_key TEXT NOT NULL UNIQUE,
  bytes INTEGER NOT NULL,
  content_type TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(job_id, name)
);
