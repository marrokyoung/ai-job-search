CREATE TABLE job_sources (
  id TEXT PRIMARY KEY NOT NULL,
  source_key TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE organizations (
  id TEXT PRIMARY KEY NOT NULL,
  normalized_name TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE jobs (
  id TEXT PRIMARY KEY NOT NULL,
  source_id TEXT NOT NULL REFERENCES job_sources(id),
  source_job_id TEXT,
  canonical_url TEXT,
  organization_id TEXT REFERENCES organizations(id),
  discovered_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  CONSTRAINT jobs_source_identity_unique UNIQUE (source_id, source_job_id),
  CONSTRAINT jobs_has_identity CHECK (source_job_id IS NOT NULL OR canonical_url IS NOT NULL)
) STRICT;

CREATE UNIQUE INDEX jobs_canonical_url_unique
  ON jobs(canonical_url)
  WHERE canonical_url IS NOT NULL;

CREATE TABLE job_snapshots (
  id TEXT PRIMARY KEY NOT NULL,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  content_hash TEXT NOT NULL,
  title TEXT NOT NULL,
  location_text TEXT,
  workplace_type TEXT NOT NULL CHECK (workplace_type IN ('remote', 'hybrid', 'onsite', 'unknown')),
  employment_type TEXT,
  description_text TEXT NOT NULL,
  posted_at TEXT,
  closes_at TEXT,
  captured_at TEXT NOT NULL,
  UNIQUE (job_id, content_hash),
  UNIQUE (id, job_id)
) STRICT;

CREATE INDEX job_snapshots_job_captured_idx
  ON job_snapshots(job_id, captured_at DESC);

CREATE TABLE requirement_extractions (
  id TEXT PRIMARY KEY NOT NULL,
  job_snapshot_id TEXT NOT NULL REFERENCES job_snapshots(id),
  status TEXT NOT NULL CHECK (status IN ('complete', 'partial', 'failed')),
  coverage_confidence REAL NOT NULL CHECK (coverage_confidence >= 0.0 AND coverage_confidence <= 1.0),
  source_text_hash TEXT NOT NULL,
  extractor_name TEXT NOT NULL,
  extractor_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (job_snapshot_id, extractor_name, extractor_version, source_text_hash)
) STRICT;

CREATE TABLE extraction_warnings (
  extraction_id TEXT NOT NULL REFERENCES requirement_extractions(id) ON DELETE CASCADE,
  warning_ordinal INTEGER NOT NULL CHECK (warning_ordinal >= 0),
  warning_text TEXT NOT NULL,
  PRIMARY KEY (extraction_id, warning_ordinal)
) STRICT, WITHOUT ROWID;

CREATE TABLE requirements (
  id TEXT PRIMARY KEY NOT NULL,
  extraction_id TEXT NOT NULL REFERENCES requirement_extractions(id) ON DELETE CASCADE,
  requirement_ordinal INTEGER NOT NULL CHECK (requirement_ordinal >= 0),
  requirement_text TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN (
    'experience_years', 'industry_experience', 'skill', 'education', 'license',
    'work_authorization', 'clearance', 'physical_or_safety', 'user_preference', 'other'
  )),
  fulfillment TEXT NOT NULL CHECK (fulfillment IN ('satisfied', 'missing', 'unknown')),
  mandatory INTEGER NOT NULL CHECK (mandatory IN (0, 1)),
  classification_confidence REAL NOT NULL CHECK (classification_confidence >= 0.0 AND classification_confidence <= 1.0),
  explanation TEXT NOT NULL,
  UNIQUE (extraction_id, requirement_ordinal),
  UNIQUE (id, extraction_id)
) STRICT;

CREATE TABLE requirement_source_spans (
  requirement_id TEXT NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
  span_ordinal INTEGER NOT NULL CHECK (span_ordinal >= 0),
  start_offset INTEGER NOT NULL CHECK (start_offset >= 0),
  end_offset INTEGER NOT NULL,
  quoted_text TEXT NOT NULL,
  PRIMARY KEY (requirement_id, span_ordinal),
  CONSTRAINT requirement_span_order CHECK (end_offset > start_offset)
) STRICT, WITHOUT ROWID;

CREATE TABLE eligibility_assessments (
  id TEXT PRIMARY KEY NOT NULL,
  extraction_id TEXT NOT NULL REFERENCES requirement_extractions(id),
  status TEXT NOT NULL CHECK (status IN ('eligible', 'blocked', 'needs_review')),
  evaluator_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (id, extraction_id)
) STRICT;

CREATE TABLE requirement_assessments (
  id TEXT PRIMARY KEY NOT NULL,
  eligibility_assessment_id TEXT NOT NULL,
  requirement_id TEXT NOT NULL,
  extraction_id TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('satisfied', 'soft_gap', 'hard_stop', 'unknown')),
  explanation TEXT NOT NULL,
  UNIQUE (eligibility_assessment_id, requirement_id),
  FOREIGN KEY (eligibility_assessment_id, extraction_id)
    REFERENCES eligibility_assessments(id, extraction_id) ON DELETE CASCADE,
  FOREIGN KEY (requirement_id, extraction_id)
    REFERENCES requirements(id, extraction_id)
) STRICT;

CREATE TABLE extraction_issues (
  id TEXT PRIMARY KEY NOT NULL,
  eligibility_assessment_id TEXT NOT NULL REFERENCES eligibility_assessments(id) ON DELETE CASCADE,
  issue_ordinal INTEGER NOT NULL CHECK (issue_ordinal >= 0),
  issue_code TEXT NOT NULL,
  explanation TEXT NOT NULL,
  UNIQUE (eligibility_assessment_id, issue_ordinal)
) STRICT;

CREATE TABLE applications (
  id TEXT PRIMARY KEY NOT NULL,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  job_snapshot_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL CHECK (attempt_number >= 1),
  current_state TEXT NOT NULL CHECK (current_state IN (
    'discovered', 'normalized', 'eligible', 'hard_stopped', 'needs_review', 'shortlisted',
    'skipped', 'preparing', 'verification_failed', 'ready_to_submit', 'awaiting_approval',
    'submitting', 'submitted', 'submission_failed', 'confirmation_received', 'assessment',
    'recruiter_contact', 'interview', 'rejected', 'offer', 'withdrawn', 'closed_unknown'
  )),
  automation_mode TEXT NOT NULL CHECK (automation_mode IN ('manual', 'assisted', 'autonomous')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (job_id, attempt_number),
  FOREIGN KEY (job_snapshot_id, job_id) REFERENCES job_snapshots(id, job_id)
) STRICT;

CREATE UNIQUE INDEX applications_one_open_per_job
  ON applications(job_id)
  WHERE current_state NOT IN ('skipped', 'rejected', 'withdrawn', 'closed_unknown');

CREATE TRIGGER applications_identity_immutable
BEFORE UPDATE ON applications
WHEN NEW.id != OLD.id
  OR NEW.job_id != OLD.job_id
  OR NEW.job_snapshot_id != OLD.job_snapshot_id
  OR NEW.attempt_number != OLD.attempt_number
  OR NEW.created_at != OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'applications allow only current_state, automation_mode, and updated_at updates');
END;

CREATE TABLE application_approvals (
  id TEXT PRIMARY KEY NOT NULL,
  application_id TEXT NOT NULL REFERENCES applications(id),
  approval_kind TEXT NOT NULL CHECK (approval_kind IN ('human', 'policy')),
  approved_by TEXT NOT NULL CHECK (approved_by IN ('user', 'system')),
  approval_reference TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  CONSTRAINT approval_actor_matches_kind CHECK (
    (approval_kind = 'human' AND approved_by = 'user') OR
    (approval_kind = 'policy' AND approved_by = 'system')
  )
) STRICT;

CREATE TABLE verification_results (
  id TEXT PRIMARY KEY NOT NULL,
  application_id TEXT NOT NULL REFERENCES applications(id),
  verification_reference TEXT NOT NULL UNIQUE,
  result TEXT NOT NULL CHECK (result IN ('passed', 'failed')),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE application_events (
  id TEXT PRIMARY KEY NOT NULL,
  application_id TEXT NOT NULL REFERENCES applications(id),
  sequence_number INTEGER NOT NULL CHECK (sequence_number >= 1),
  event_type TEXT NOT NULL,
  actor TEXT NOT NULL CHECK (actor IN ('user', 'agent', 'system', 'external')),
  from_state TEXT,
  to_state TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  reason TEXT NOT NULL,
  correlation_id TEXT,
  idempotency_key TEXT,
  supersedes_event_id TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE (application_id, sequence_number),
  UNIQUE (id, application_id),
  UNIQUE (idempotency_key),
  FOREIGN KEY (supersedes_event_id, application_id)
    REFERENCES application_events(id, application_id),
  CONSTRAINT application_event_payload_is_json CHECK (json_valid(payload_json))
) STRICT;

CREATE INDEX application_events_timeline_idx
  ON application_events(application_id, sequence_number);

CREATE UNIQUE INDEX application_events_supersedes_once_unique
  ON application_events(supersedes_event_id)
  WHERE supersedes_event_id IS NOT NULL;

CREATE TRIGGER application_events_reject_update
BEFORE UPDATE ON application_events
BEGIN
  SELECT RAISE(ABORT, 'application_events are append-only');
END;

CREATE TRIGGER application_events_reject_delete
BEFORE DELETE ON application_events
BEGIN
  SELECT RAISE(ABORT, 'application_events are append-only');
END;

CREATE TRIGGER application_approvals_reject_update
BEFORE UPDATE ON application_approvals
BEGIN
  SELECT RAISE(ABORT, 'application_approvals are immutable evidence');
END;

CREATE TRIGGER application_approvals_reject_delete
BEFORE DELETE ON application_approvals
BEGIN
  SELECT RAISE(ABORT, 'application_approvals are immutable evidence');
END;

CREATE TRIGGER verification_results_reject_update
BEFORE UPDATE ON verification_results
BEGIN
  SELECT RAISE(ABORT, 'verification_results are immutable evidence');
END;

CREATE TRIGGER verification_results_reject_delete
BEFORE DELETE ON verification_results
BEGIN
  SELECT RAISE(ABORT, 'verification_results are immutable evidence');
END;

CREATE TRIGGER requirement_extractions_reject_update
BEFORE UPDATE ON requirement_extractions
BEGIN
  SELECT RAISE(ABORT, 'requirement_extractions are immutable evidence');
END;

CREATE TRIGGER requirement_extractions_reject_delete
BEFORE DELETE ON requirement_extractions
BEGIN
  SELECT RAISE(ABORT, 'requirement_extractions are immutable evidence');
END;

CREATE TRIGGER extraction_warnings_reject_update
BEFORE UPDATE ON extraction_warnings
BEGIN
  SELECT RAISE(ABORT, 'extraction_warnings are immutable evidence');
END;

CREATE TRIGGER extraction_warnings_reject_delete
BEFORE DELETE ON extraction_warnings
BEGIN
  SELECT RAISE(ABORT, 'extraction_warnings are immutable evidence');
END;

CREATE TRIGGER requirements_reject_update
BEFORE UPDATE ON requirements
BEGIN
  SELECT RAISE(ABORT, 'requirements are immutable evidence');
END;

CREATE TRIGGER requirements_reject_delete
BEFORE DELETE ON requirements
BEGIN
  SELECT RAISE(ABORT, 'requirements are immutable evidence');
END;

CREATE TRIGGER requirement_source_spans_reject_update
BEFORE UPDATE ON requirement_source_spans
BEGIN
  SELECT RAISE(ABORT, 'requirement_source_spans are immutable evidence');
END;

CREATE TRIGGER requirement_source_spans_reject_delete
BEFORE DELETE ON requirement_source_spans
BEGIN
  SELECT RAISE(ABORT, 'requirement_source_spans are immutable evidence');
END;

CREATE TRIGGER eligibility_assessments_reject_update
BEFORE UPDATE ON eligibility_assessments
BEGIN
  SELECT RAISE(ABORT, 'eligibility_assessments are immutable evidence');
END;

CREATE TRIGGER eligibility_assessments_reject_delete
BEFORE DELETE ON eligibility_assessments
BEGIN
  SELECT RAISE(ABORT, 'eligibility_assessments are immutable evidence');
END;

CREATE TRIGGER requirement_assessments_reject_update
BEFORE UPDATE ON requirement_assessments
BEGIN
  SELECT RAISE(ABORT, 'requirement_assessments are immutable evidence');
END;

CREATE TRIGGER requirement_assessments_reject_delete
BEFORE DELETE ON requirement_assessments
BEGIN
  SELECT RAISE(ABORT, 'requirement_assessments are immutable evidence');
END;

CREATE TRIGGER extraction_issues_reject_update
BEFORE UPDATE ON extraction_issues
BEGIN
  SELECT RAISE(ABORT, 'extraction_issues are immutable evidence');
END;

CREATE TRIGGER extraction_issues_reject_delete
BEFORE DELETE ON extraction_issues
BEGIN
  SELECT RAISE(ABORT, 'extraction_issues are immutable evidence');
END;

CREATE TABLE review_items (
  id TEXT PRIMARY KEY NOT NULL,
  application_id TEXT REFERENCES applications(id),
  eligibility_assessment_id TEXT REFERENCES eligibility_assessments(id),
  review_type TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'resolved', 'dismissed')),
  summary TEXT NOT NULL,
  resolution_reason TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  CONSTRAINT review_has_one_subject CHECK (
    (application_id IS NOT NULL) != (eligibility_assessment_id IS NOT NULL)
  ),
  CONSTRAINT review_resolution_consistent CHECK (
    (status = 'open' AND resolved_at IS NULL AND resolution_reason IS NULL) OR
    (status IN ('resolved', 'dismissed') AND resolved_at IS NOT NULL AND resolution_reason IS NOT NULL)
  )
) STRICT;

CREATE TABLE source_policies (
  source_id TEXT PRIMARY KEY NOT NULL REFERENCES job_sources(id),
  discovery_allowed INTEGER NOT NULL CHECK (discovery_allowed IN (0, 1)),
  detail_retrieval_allowed INTEGER NOT NULL CHECK (detail_retrieval_allowed IN (0, 1)),
  assisted_submission_allowed INTEGER NOT NULL CHECK (assisted_submission_allowed IN (0, 1)),
  autonomous_submission_allowed INTEGER NOT NULL CHECK (autonomous_submission_allowed IN (0, 1)),
  outcome_sync_allowed INTEGER NOT NULL CHECK (outcome_sync_allowed IN (0, 1)),
  updated_at TEXT NOT NULL
) STRICT, WITHOUT ROWID;

CREATE TABLE automation_settings (
  singleton_id INTEGER PRIMARY KEY NOT NULL CHECK (singleton_id = 1),
  globally_paused INTEGER NOT NULL CHECK (globally_paused IN (0, 1)),
  default_mode TEXT NOT NULL CHECK (default_mode IN ('manual', 'assisted', 'autonomous')),
  daily_application_limit INTEGER NOT NULL CHECK (daily_application_limit >= 0),
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY NOT NULL,
  application_id TEXT REFERENCES applications(id),
  job_id TEXT REFERENCES jobs(id),
  event_name TEXT NOT NULL,
  actor TEXT NOT NULL CHECK (actor IN ('user', 'agent', 'system', 'external')),
  occurred_at TEXT NOT NULL,
  correlation_id TEXT,
  details_json TEXT NOT NULL DEFAULT '{}',
  CONSTRAINT audit_details_is_json CHECK (json_valid(details_json))
) STRICT;

CREATE TRIGGER audit_events_reject_update
BEFORE UPDATE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events are append-only');
END;

CREATE TRIGGER audit_events_reject_delete
BEFORE DELETE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events are append-only');
END;

INSERT INTO automation_settings (
  singleton_id, globally_paused, default_mode, daily_application_limit, updated_at
) VALUES (1, 1, 'assisted', 10, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
