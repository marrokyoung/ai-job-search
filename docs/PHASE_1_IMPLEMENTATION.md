# Phase 1 Implementation Plan: Executable Local Shell

## Objective

Deliver an installable, local-first Windows desktop application that can store synthetic jobs and applications, evaluate them with the configured lenient eligibility policy, display their lifecycle, and preserve a deterministic audit trail. Phase 1 does not make live job-board requests, call an AI provider, connect email, or submit applications.

This creates the safe foundation those capabilities need.

## Deliverables

1. Electron application that runs in development and builds a Windows installer.
2. React interface with Dashboard, Jobs, Applications, Review Queue, and Settings routes.
3. SQLite database initialized through versioned migrations.
4. Typed domain model shared by the desktop main process and renderer.
5. Deterministic eligibility evaluator distinguishing hard stops from soft gaps.
6. Append-only application event log with validated transitions.
7. Synthetic seed data and no real candidate information.
8. Automated unit, migration, privacy, and renderer smoke tests.
9. Provider-neutral agent contract and deterministic paid-fallback protection.

## Proposed repository layout

```text
apps/
  desktop/
    src/
      main/                  # Electron lifecycle, database, IPC
      preload/               # narrow typed IPC bridge
      renderer/              # React UI
    tests/
    package.json
packages/
  domain/
    src/                     # entities, policies, state machine
    tests/
  database/
    src/                     # SQLite access and migrations
    migrations/
    tests/
  fixtures/
    synthetic/               # fake jobs and candidate data
docs/
  PRODUCT_PLAN.md
  PHASE_1_IMPLEMENTATION.md
package.json                 # workspace commands only
tsconfig.base.json
```

Runtime databases, generated files, browser profiles, and logs must not live anywhere in this tree.

## Domain model

### Job

```ts
type Job = {
  id: string;
  source: string;
  sourceJobId: string | null;
  canonicalUrl: string;
  title: string;
  company: string;
  locationText: string | null;
  workplaceType: "remote" | "hybrid" | "onsite" | "unknown";
  employmentType: string | null;
  descriptionText: string;
  postedAt: string | null;
  closesAt: string | null;
  discoveredAt: string;
  contentHash: string;
};
```

### Requirement assessment

```ts
type RequirementAssessment = {
  requirement: string;
  category:
    | "experience_years"
    | "industry_experience"
    | "skill"
    | "education"
    | "license"
    | "work_authorization"
    | "clearance"
    | "physical_or_safety"
    | "user_preference"
    | "other";
  severity: "soft_gap" | "hard_stop" | "unknown" | "satisfied";
  classificationConfidence: number;
  sourceSpans: Array<{ start: number; end: number; quote: string }>;
  evidenceIds: string[];
  explanation: string;
};
```

The evaluator cannot turn `experience_years` or `industry_experience` into a hard stop. A future AI extractor may propose categories, but deterministic policy computes severity. Extraction is wrapped in a completeness result with coverage confidence and a posting hash. Failed, partial, empty, low-confidence, contradictory, or untraceable extraction enters review rather than defaulting to eligible.

### Application

```ts
type Application = {
  id: string;
  jobId: string;
  currentState: ApplicationState;
  automationMode: "manual" | "assisted" | "autonomous";
  createdAt: string;
  updatedAt: string;
};
```

### Application event

```ts
type ApplicationEvent = {
  id: string;
  applicationId: string;
  type: string;
  actor: "user" | "agent" | "system" | "external";
  occurredAt: string;
  reason: string;
  payloadJson: string;
  correlationId: string | null;
};
```

Events are immutable. Corrections append a compensating event.

## Database schema

SQLite is the local authoritative store. The authoritative schema targets third
normal form and BCNF where the business keys permit it: sources, organizations,
job identities, posting snapshots, extractions, requirements, assessments,
approvals, verification results, and events are separate relations. Repeating
values use child tables rather than arrays or queryable JSON. DynamoDB is not a
Phase 1 dependency; a future synchronization service can consume the event log
without weakening the local schema or requiring cloud setup.

SQLite does not constrain the implementation language. Phase 1 uses a typed
Node adapter because the database lives in Electron's main process; a future
isolated Rust worker can use the same schema through `rusqlite` or `sqlx` if a
measured workload justifies the additional process boundary.

Versioned SQL files under `packages/database/migrations/` are the single source
of truth for the database schema. Repositories use prepared SQLite statements;
the public database handle exposes only lifecycle operations, not the raw
connection or a query object that can reveal it. This keeps SQLite checks,
partial indexes, strict-table declarations, composite foreign keys, and
immutability triggers in one reviewable representation. Migration
versions are parsed numerically and must be unique and contiguous from version
1; an unapplied migration cannot be inserted below the highest applied version.
The runner applies each migration and its ledger row in a single transaction,
and rejects migration files containing statement-level transaction control
(BEGIN, COMMIT, END, ROLLBACK, SAVEPOINT, RELEASE) so a migration cannot commit
partial schema changes; trigger bodies and CASE expressions remain allowed.

`applications.current_state` is the sole deliberate operational
denormalization. It is a transactionally maintained, rebuildable projection of
the immutable application event stream so the desktop UI does not replay every
application on every list view.

Each application is pinned to the exact posting snapshot used to evaluate it.
Eligibility and requirement-assessment relations use composite foreign keys so
an assessment cannot cite a requirement from another extraction or posting.

Initial tables:

- `schema_migrations`
- `jobs`
- `job_snapshots`
- `requirement_assessments`
- `applications`
- `application_events`
- `review_items`
- `source_policies`
- `automation_settings`
- `audit_events`

Supporting normalized tables include job sources, organizations, requirement
extractions and warnings, requirement source spans, extraction issues,
application approvals, and verification results.

Key constraints:

- unique `(source, source_job_id)` when a source identifier exists;
- unique canonical URL where reliable;
- unique application per job unless the user explicitly records a reapplication;
- foreign keys enabled;
- application state changes occur in the same transaction as their event;
- external actions use a unique idempotency key.
- database triggers reject updates and deletes of application events, audit
  events, approvals, verification results, and the extraction/assessment
  evidence chain;
- a compensating event can supersede an event only once and only when that event
  is the latest effective outcome.

## Eligibility policy

Phase 1 implements this without an LLM:

```text
If any assessment is hard_stop:
    eligibility = blocked
Else if any assessment is unknown:
    eligibility = needs_review
Else:
    eligibility = eligible
```

Soft gaps affect ranking and tailoring context only. They never make a job ineligible.

Policy invariants:

- `experience_years` is never a hard stop.
- `industry_experience` is never a hard stop.
- missing preferred skills are never hard stops.
- a mandatory license can block only when the candidate fact store explicitly says it is absent.
- unknown mandatory facts create review items rather than guessed answers.
- every initial eligibility state requires a persisted assessment for the
  application's exact posting snapshot with a matching result;
- clearing `needs_review` requires both a new eligibility-assessment reference and corrected or newly verified candidate-fact references;
- the referenced assessment must be persisted for the application's exact
  posting snapshot and its result must match the requested state;
- until candidate facts have a persisted ledger, `needs_review -> eligible` is
  deliberately unavailable rather than trusting caller-supplied identifiers;
- user overrides are recorded with a reason and can unblock any non-legal policy item.

## State machine

Phase 1 supports:

```text
discovered -> normalized
normalized -> eligible | hard_stopped | needs_review
eligible -> shortlisted | skipped
shortlisted -> preparing
preparing -> verification_failed | ready_to_submit
verification_failed -> preparing | skipped
ready_to_submit -> awaiting_approval
awaiting_approval -> submitting | skipped
submitting -> submitted | submission_failed
submission_failed -> submitting | needs_review | skipped
submitted -> confirmation_received | assessment | recruiter_contact | interview | rejected | offer | withdrawn | closed_unknown
confirmation_received -> assessment | recruiter_contact | interview | rejected | offer | withdrawn | closed_unknown
assessment -> interview | rejected | offer | withdrawn | closed_unknown
recruiter_contact -> interview | rejected | offer | withdrawn | closed_unknown
interview -> interview | rejected | offer | withdrawn | closed_unknown
```

The domain package rejects invalid transitions with a typed error and creates no partial database writes. `needs_review` cannot transition directly to `shortlisted`; it must be reevaluated into `eligible` first.

Submission uses a contextual transition command, not topology alone. It records automation mode, actor, human or policy approval reference, verification-result reference, source submission policy, global-pause state, and idempotency key. Manual and assisted modes require user approval; autonomous mode requires a recorded policy approval. Every mode passes through `awaiting_approval`, which represents either human approval or the autonomous policy gate.

Outcome corrections are separate user-authorized compensating events. They reference the superseded outcome event and preserve the original classification in history rather than reopening through an ordinary transition.

## IPC boundary

The renderer receives a narrow API exposed by the preload script:

- list dashboard metrics;
- list/filter jobs;
- read one job and its assessments;
- list/read applications and timelines;
- create or resolve a review item;
- update non-secret settings;
- pause or resume automation.

The renderer cannot access the filesystem, database, shell, or environment directly.

Every IPC request and response is runtime-validated.

## Agent provider contract

Phase 1 defines provider selection and availability without invoking a model. Supported provider kinds are:

- `claude_code_local` — subscription-capable local Claude Code process;
- `codex_local` — subscription-capable local Codex SDK/runtime;
- `anthropic_api` — metered direct API;
- `openai_api` — metered direct API;
- `fake` — deterministic synthetic provider used by tests and development.

Each provider reports availability (`available`, `unavailable`, `needs_auth`, or `rate_limited`) and billing mode (`subscription`, `api_metered`, `local_free`, or `unknown`). Provider credentials remain owned by the local runtime or OS credential store; they never cross the renderer IPC boundary.

Selection rules:

- prefer the configured primary provider when available;
- consider fallback providers only in the configured order;
- never select an `api_metered` fallback unless `allowPaidApiFallback` is explicitly true;
- return a visible paused/no-provider decision when no permitted provider is available;
- do not silently reinterpret authentication failures as permission to use another billing account.

## Initial interface

### Dashboard

- state-count cards;
- recent application events;
- unresolved review items;
- automation paused/running indicator;
- synthetic-data banner in development mode.

### Jobs

- sortable job table;
- eligible, blocked, and needs-review filters;
- visible soft-gap count;
- job detail drawer with assessments and evidence placeholders.

### Applications

- application table and state filter;
- timeline view built from immutable events;
- visible automation mode and latest failure.

### Review queue

- unknown requirements and invalid-transition diagnostics;
- resolve, override with reason, or skip actions.

### Settings

- default automation mode;
- daily application ceiling;
- pause control;
- local data path display;
- destructive-data controls present but disabled until their confirmation flows are implemented.

## Privacy implementation

- Resolve runtime paths through Electron's `app.getPath("userData")`.
- Add ignore rules for SQLite, WAL/SHM files, runtime artifacts, browser profiles, and logs.
- Use synthetic names, companies, email addresses, and documents in tests.
- Add a repository privacy check that rejects common email/phone patterns outside explicitly approved synthetic fixtures.
- Keep logs structured and redact values classified as contact, token, answer, or message content.
- Do not implement telemetry in Phase 1.

## Test strategy

### Domain tests

- five-to-seven years requested with zero years produces `soft_gap` and remains eligible;
- zero automotive-industry experience remains a soft gap;
- absent mandatory professional license produces a hard stop;
- unknown license status produces needs-review;
- missing preferred tool remains eligible;
- invalid state transitions fail without emitting events;
- retries retain one application and append attempts.
- an unavailable subscription provider does not fall back to a metered API by default;
- a metered fallback can be selected only after explicit opt-in;

### Database tests

- migrations build an empty database;
- foreign keys and uniqueness constraints hold;
- state and event commits are atomic;
- the current-state projection can be rebuilt from events.

### Desktop tests

- preload exposes only the documented API;
- renderer loads synthetic dashboard data;
- primary routes render;
- pause setting persists across restart.

### Privacy tests

- public tree contains no real profile data;
- runtime database path is outside the repository;
- logs redact fixture secrets;
- packaging excludes development fixtures and local databases.

## Milestone sequence

### 1A. Workspace and domain foundation

- create workspace manifests and shared TypeScript configuration;
- implement domain types, eligibility policy, and state machine;
- define provider capabilities, availability, billing modes, and selection policy;
- add unit tests, including the automotive-engineer scenario;
- add runtime-data ignore rules.

### 1B. SQLite persistence

- implement migrations and repositories;
- add event transactions and idempotency constraints;
- add synthetic seed command for development.

### 1C. Electron shell

- create secure main/preload/renderer boundaries;
- implement application-data path resolution;
- wire typed IPC to repositories.

### 1D. Core interface

- implement Dashboard, Jobs, Applications, Review Queue, and Settings;
- add empty, loading, error, and paused states;
- add accessible keyboard navigation and labels.

### 1E. Packaging and CI

- build a Windows installer artifact;
- run unit, migration, renderer, and privacy checks in CI;
- document local development and installation.

## Definition of done

- A clean clone installs dependencies and starts the desktop app using documented commands.
- CI builds the application and runs all Phase 1 tests.
- A Windows installer artifact is produced.
- Synthetic jobs survive restart in SQLite.
- The automotive-engineer fixture remains eligible despite the experience gap.
- A mandatory missing license blocks and explains why.
- Every application transition appears in its timeline.
- No renderer code has direct Node, filesystem, database, or shell access.
- No real personal information exists in the branch or packaged artifacts.
- No live network request or external application submission occurs in Phase 1.

## First implementation slice

Start with Milestone 1A. It is independently testable and fixes the most important behavioral contract before UI or automation work can obscure it:

1. establish the TypeScript workspace;
2. define domain types;
3. implement eligibility evaluation;
4. implement the application transition validator;
5. add tests for broad-application leniency and hard stops;
6. add runtime-data ignore rules.
