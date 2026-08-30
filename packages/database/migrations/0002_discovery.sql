-- Phase 2A: discovery foundation.
--
-- Additive only. 0001_initial.sql has shipped and is never edited. This
-- migration models discovery runs, per-source operational controls and health,
-- append-only posting observations, per-job freshness/expiration, conservative
-- cross-source duplicate candidates, and makes posting snapshots immutable.
--
-- Source *capabilities/policy* already live in source_policies (0001); this adds
-- the operational enable/disable, kill switch, and expiration grace controls.

-- One row per discovery run. Mutable only from 'running' to a terminal status
-- (the run's own completion); rows are never deleted, so run history survives.
CREATE TABLE discovery_runs (
  id TEXT PRIMARY KEY NOT NULL,
  source_id TEXT NOT NULL REFERENCES job_sources(id),
  trigger TEXT NOT NULL CHECK (trigger IN ('manual', 'scheduled', 'test')),
  authoritative INTEGER NOT NULL CHECK (authoritative IN (0, 1)),
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'partial', 'failed', 'skipped')),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  postings_seen INTEGER NOT NULL DEFAULT 0 CHECK (postings_seen >= 0),
  new_jobs INTEGER NOT NULL DEFAULT 0 CHECK (new_jobs >= 0),
  new_snapshots INTEGER NOT NULL DEFAULT 0 CHECK (new_snapshots >= 0),
  failure_count INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  expired_jobs INTEGER NOT NULL DEFAULT 0 CHECK (expired_jobs >= 0),
  skip_reason TEXT,
  CONSTRAINT run_finished_when_terminal CHECK (
    (status = 'running' AND finished_at IS NULL) OR
    (status != 'running' AND finished_at IS NOT NULL)
  )
) STRICT;

CREATE INDEX discovery_runs_source_started_idx
  ON discovery_runs(source_id, started_at DESC);

CREATE TRIGGER discovery_runs_reject_delete
BEFORE DELETE ON discovery_runs
BEGIN
  SELECT RAISE(ABORT, 'discovery_runs are retained history and cannot be deleted');
END;

-- A run advances 'running' -> terminal exactly once. Once terminal, the row is
-- frozen: no re-finalization, no rewriting counts or status after the fact.
CREATE TRIGGER discovery_runs_freeze_terminal
BEFORE UPDATE ON discovery_runs
WHEN OLD.status != 'running'
BEGIN
  SELECT RAISE(ABORT, 'a finalized discovery_run cannot be modified');
END;

-- Append-only classified failures for a run. Only a safe category and a fixed
-- message are stored; raw response content never reaches this table.
CREATE TABLE discovery_run_failures (
  run_id TEXT NOT NULL REFERENCES discovery_runs(id),
  failure_ordinal INTEGER NOT NULL CHECK (failure_ordinal >= 0),
  category TEXT NOT NULL CHECK (category IN (
    'network', 'timeout', 'rate_limited', 'auth', 'parse', 'schema', 'policy',
    'cross_source_duplicate', 'internal'
  )),
  message TEXT NOT NULL,
  PRIMARY KEY (run_id, failure_ordinal)
) STRICT, WITHOUT ROWID;

CREATE TRIGGER discovery_run_failures_reject_update
BEFORE UPDATE ON discovery_run_failures
BEGIN
  SELECT RAISE(ABORT, 'discovery_run_failures are append-only');
END;

CREATE TRIGGER discovery_run_failures_reject_delete
BEFORE DELETE ON discovery_run_failures
BEGIN
  SELECT RAISE(ABORT, 'discovery_run_failures are append-only');
END;

-- Per-source operational controls. A source cannot run until this row and its
-- source_policies row exist (capability/policy defined before running).
CREATE TABLE source_discovery_settings (
  source_id TEXT PRIMARY KEY NOT NULL REFERENCES job_sources(id),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  kill_switch_engaged INTEGER NOT NULL CHECK (kill_switch_engaged IN (0, 1)),
  expiration_grace_seconds INTEGER NOT NULL CHECK (expiration_grace_seconds >= 0),
  updated_at TEXT NOT NULL
) STRICT, WITHOUT ROWID;

-- Rebuildable last-run health projection per source.
CREATE TABLE source_health (
  source_id TEXT PRIMARY KEY NOT NULL REFERENCES job_sources(id),
  last_run_id TEXT REFERENCES discovery_runs(id),
  last_status TEXT CHECK (last_status IN ('succeeded', 'partial', 'failed', 'skipped')),
  last_run_at TEXT,
  last_success_at TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  updated_at TEXT NOT NULL
) STRICT, WITHOUT ROWID;

-- Append-only "seen in this run" records: the authority for last-seen and
-- expiration. One observation per job per run.
CREATE TABLE posting_observations (
  id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL REFERENCES discovery_runs(id),
  job_id TEXT NOT NULL REFERENCES jobs(id),
  job_snapshot_id TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  content_changed INTEGER NOT NULL CHECK (content_changed IN (0, 1)),
  UNIQUE (run_id, job_id),
  FOREIGN KEY (job_snapshot_id, job_id) REFERENCES job_snapshots(id, job_id)
) STRICT;

CREATE INDEX posting_observations_job_idx
  ON posting_observations(job_id, observed_at DESC);

CREATE TRIGGER posting_observations_reject_update
BEFORE UPDATE ON posting_observations
BEGIN
  SELECT RAISE(ABORT, 'posting_observations are append-only');
END;

CREATE TRIGGER posting_observations_reject_delete
BEFORE DELETE ON posting_observations
BEGIN
  SELECT RAISE(ABORT, 'posting_observations are append-only');
END;

-- Per-job freshness/expiration projection plus the job's canonical fingerprint.
CREATE TABLE job_discovery_state (
  job_id TEXT PRIMARY KEY NOT NULL REFERENCES jobs(id),
  source_id TEXT NOT NULL REFERENCES job_sources(id),
  fingerprint TEXT NOT NULL,
  first_seen_run_id TEXT NOT NULL REFERENCES discovery_runs(id),
  last_seen_run_id TEXT NOT NULL REFERENCES discovery_runs(id),
  last_seen_at TEXT NOT NULL,
  expired INTEGER NOT NULL DEFAULT 0 CHECK (expired IN (0, 1)),
  expired_at TEXT,
  expired_by_run_id TEXT REFERENCES discovery_runs(id),
  CONSTRAINT expiry_consistent CHECK (
    (expired = 0 AND expired_at IS NULL AND expired_by_run_id IS NULL) OR
    (expired = 1 AND expired_at IS NOT NULL AND expired_by_run_id IS NOT NULL)
  )
) STRICT, WITHOUT ROWID;

CREATE INDEX job_discovery_state_fingerprint_idx
  ON job_discovery_state(fingerprint);

CREATE INDEX job_discovery_state_source_idx
  ON job_discovery_state(source_id, expired);

-- Inspectable cross-source duplicate candidates. Fingerprint similarity never
-- merges jobs; it only records a candidate/ambiguous link for human inspection.
CREATE TABLE job_duplicate_links (
  id TEXT PRIMARY KEY NOT NULL,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  matched_job_id TEXT NOT NULL REFERENCES jobs(id),
  fingerprint TEXT NOT NULL,
  match_type TEXT NOT NULL CHECK (match_type IN ('fingerprint')),
  status TEXT NOT NULL CHECK (status IN ('candidate', 'ambiguous')),
  discovery_run_id TEXT NOT NULL REFERENCES discovery_runs(id),
  created_at TEXT NOT NULL,
  CONSTRAINT duplicate_link_distinct CHECK (job_id != matched_job_id),
  UNIQUE (job_id, matched_job_id)
) STRICT;

CREATE INDEX job_duplicate_links_matched_idx
  ON job_duplicate_links(matched_job_id);

-- Posting snapshots are immutable evidence: content changes create a new
-- snapshot rather than editing an existing one.
CREATE TRIGGER job_snapshots_reject_update
BEFORE UPDATE ON job_snapshots
BEGIN
  SELECT RAISE(ABORT, 'job_snapshots are immutable evidence');
END;

CREATE TRIGGER job_snapshots_reject_delete
BEFORE DELETE ON job_snapshots
BEGIN
  SELECT RAISE(ABORT, 'job_snapshots are immutable evidence');
END;
