# Phase 1B Review Fix Handoff

## Purpose

Finish and validate the Phase 1B SQLite review fixes already present in the
uncommitted working tree. Do not restart Phase 1B or redesign the persistence
layer. Inspect the existing changes, correct any incomplete implementation, add
missing regression coverage, and leave the branch ready for one clean Phase 1B
commit.

The canonical requirements are in:

- `docs/PRODUCT_PLAN.md`
- `docs/PHASE_1_IMPLEMENTATION.md`
- `packages/domain/src/state-machine.ts`

## Current state

The original review found six issues:

1. application events and immutable evidence could be updated or deleted;
2. eligibility transitions accepted invented evidence references;
3. requirement assessments could cite requirements from another extraction;
4. outcome corrections could supersede stale or already-superseded events;
5. migration ordering relied on lexicographic filenames;
6. handwritten SQL and the Drizzle schema duplicated the schema authority.

Another agent has already attempted fixes for all six. The working tree now
appears to include:

- SQL immutability triggers;
- a narrow public database handle with raw SQLite access kept internal;
- persisted eligibility-assessment validation;
- composite foreign keys tying applications, assessments, requirements, and
  extractions to the same posting snapshot;
- one-time and latest-effective-event correction checks;
- numeric, contiguous migration validation;
- versioned SQL migrations as the documented schema source of truth;
- expanded database regression tests.

At handoff creation time, these commands pass:

```text
bun run typecheck
bun run test
```

They report 24 domain tests and 14 SQLite tests. Treat that only as a baseline;
audit the behavior rather than assuming the attempted fixes are correct.

## Constraints and decisions

- SQLite remains the local authoritative database.
- Versioned SQL files in `packages/database/migrations/` are the single schema
  authority. Do not restore a second Drizzle schema representation.
- Keep raw SQLite access private to the database package implementation.
- `applications.current_state` remains the only deliberate mutable projection
  and must remain rebuildable from `application_events`.
- Event and evidence history is append-only. Corrections are new compensating
  events, never edits.
- Phase 1B is still uncommitted and migration `0001_initial.sql` has not shipped.
  Correct that migration in place; do not add a `0002` solely to repair the
  unshipped initial schema.
- Do not begin Phase 1C, Electron, preload, IPC, UI, live network access, or
  external submission work.
- Preserve unrelated user changes in the dirty working tree.

## Implementation checklist

### 1. Audit database-level immutability

Confirm SQLite itself rejects `UPDATE` and `DELETE` for:

- `application_events`;
- `audit_events`;
- `application_approvals`;
- `verification_results`;
- the requirement extraction and eligibility assessment evidence chain.

Repository conventions alone are insufficient because internal code can access
the connection. Verify failed mutations leave both the event stream and
`applications.current_state` unchanged.

### 2. Audit eligibility evidence integrity

For `normalized -> eligible | hard_stopped | needs_review`, require a persisted
eligibility assessment that:

- exists;
- belongs to the application's pinned job snapshot;
- has a status matching the target application state.

For `needs_review -> hard_stopped`, apply the same persisted assessment checks.

For `needs_review -> eligible`, fail closed until a persisted candidate-fact
ledger exists. Caller-supplied, nonblank candidate-fact strings must not be
treated as proof. Document this deliberate Phase 1 limitation if it is not
already clear.

Use one explicit mapping between assessment and application state:

```text
eligible     -> eligible
blocked      -> hard_stopped
needs_review -> needs_review
```

### 3. Audit relational consistency

Confirm constraints prevent all cross-boundary associations:

- an application cannot pin a snapshot belonging to another job;
- an eligibility assessment is tied to one extraction and posting snapshot;
- a requirement assessment cannot combine an assessment from extraction A
  with a requirement from extraction B.

Prefer composite candidate keys and composite foreign keys over triggers or
repository-only checks. Ensure every referenced parent column set has an exact
`PRIMARY KEY` or `UNIQUE` constraint acceptable to SQLite.

Run `PRAGMA foreign_key_check` in a regression test and require zero rows.

### 4. Audit compensating corrections

An outcome correction must:

- be explicitly user-authored;
- reference an event on the same application;
- reference the latest effective event that produced the current outcome;
- supersede any event at most once;
- append a contiguous event without rewriting history;
- update `current_state` in the same transaction.

Add or retain tests for stale-event correction, cross-application correction,
and double supersession. Each rejection must leave state and event count
unchanged.

### 5. Audit migration discovery and atomicity

Migration discovery must:

- parse versions numerically;
- reject malformed `.sql` filenames rather than silently ignore them;
- reject duplicate numeric versions, including differently padded versions;
- require a contiguous sequence starting at version 1;
- reject insertion of an unapplied older migration below the highest applied
  version;
- verify the stored name and checksum for every applied migration;
- apply each migration and its ledger row in one transaction.

Also test that a deliberately failing migration leaves neither its partial
schema objects nor its `schema_migrations` row behind.

### 6. Audit the schema-authority boundary

Confirm the public package API does not expose `better-sqlite3`, the raw
connection, an ORM handle, or an escape hatch that defeats repository
invariants. Internal tests may use an explicitly internal test helper.

Ensure documentation consistently says versioned SQL is authoritative. Remove
stale claims that Drizzle owns schema or migrations. Do not add schema-parity
machinery for a representation that is no longer part of the design.

### 7. Review test quality

Keep tests behavior-focused. Avoid tests that merely assert implementation text
or trigger names. For every rejected operation, check rollback effects, not just
that an exception occurred.

At minimum, retain regression coverage for all six original findings plus:

- fresh database initialization;
- migration checksum mismatch;
- foreign-key enforcement;
- event/projection atomicity;
- idempotency-key reuse rollback;
- synthetic seed idempotence and reopen persistence.

## Verification

Run the following from the repository root:

```powershell
bun install --frozen-lockfile
bun run typecheck
bun run test
python -m unittest discover -s tests -t . -v
python tools/security_guards.py
git diff --check
bun audit
```

If PyYAML-dependent Python tests skip because PyYAML is unavailable, report the
skip accurately; do not weaken or delete those tests. Do not make live portal or
network requests.

Also inspect:

```powershell
git status --short
git diff --stat
git diff -- packages/database packages/domain docs/PRODUCT_PLAN.md docs/PHASE_1_IMPLEMENTATION.md package.json .github/workflows/ci.yml
```

## Completion report

Return a concise report containing:

1. which of the six findings were already correctly fixed;
2. what additional changes you made;
3. exact test/typecheck/security/audit results and any skips;
4. remaining risks or deferred work;
5. the proposed files for a single Phase 1B commit.

Do not commit unless explicitly asked. Stop after Phase 1B is green and ready
for review.
