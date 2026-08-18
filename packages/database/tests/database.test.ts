import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import type {
  ApplicationState,
  ApplicationTransitionCommand,
  AutomationMode,
} from "@us-job-agent/domain";
import {
  ApplicationRepository,
  JobRepository,
  openDatabase,
  seedSyntheticData,
  type JobAgentDatabase,
} from "../src/index.ts";
import { getDatabaseConnection } from "../src/database-internal.ts";
import { runMigrations } from "../src/migrations.ts";
import Database from "better-sqlite3";

const openDatabases: JobAgentDatabase[] = [];
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const database of openDatabases.splice(0)) database.close();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function openMemoryDatabase(): JobAgentDatabase {
  const database = openDatabase({ filename: ":memory:" });
  openDatabases.push(database);
  return database;
}

function connection(database: JobAgentDatabase) {
  return getDatabaseConnection(database);
}

function createFixture(database: JobAgentDatabase, suffix = "001") {
  const jobs = new JobRepository(database);
  const applications = new ApplicationRepository(database);
  const { jobId } = jobs.createWithSnapshot({
    sourceKey: "synthetic",
    sourceDisplayName: "Synthetic Source",
    sourceJobId: `role-${suffix}`,
    canonicalUrl: `https://example.invalid/jobs/role-${suffix}`,
    organizationName: "Example Engineering",
    title: "Automotive Engineer",
    workplaceType: "hybrid",
    descriptionText: "Synthetic role requesting five years of experience.",
    contentHash: `hash-${suffix}`,
    now: "2026-01-01T00:00:00.000Z",
  });
  const applicationId = applications.create({
    jobId,
    automationMode: "assisted",
    now: "2026-01-01T00:00:00.000Z",
  });
  return { applications, applicationId, jobId };
}

function command(
  from: ApplicationState,
  to: ApplicationState,
  automationMode: AutomationMode = "assisted",
): ApplicationTransitionCommand {
  return {
    from,
    to,
    authorization: {
      automationMode,
      actor: "system",
      verification: { result: "not_run" },
      sourceSubmissionAllowed: false,
      globalAutomationPaused: true,
    },
  };
}

function transitionPath(
  database: JobAgentDatabase,
  applications: ApplicationRepository,
  applicationId: string,
  states: readonly ApplicationState[],
): string[] {
  const eventIds: string[] = [];
  for (let index = 0; index < states.length - 1; index += 1) {
    const from = states[index];
    const to = states[index + 1];
    if (!from || !to) throw new Error("Invalid test path.");
    const transitionCommand = command(from, to);
    if (
      from === "normalized" &&
      (to === "eligible" || to === "hard_stopped" || to === "needs_review")
    ) {
      const snapshotId = (
        connection(database)
          .prepare("SELECT job_snapshot_id FROM applications WHERE id = ?")
          .get(applicationId) as { job_snapshot_id: string }
      ).job_snapshot_id;
      const assessmentId = `assessment-${applicationId}-${to}`;
      insertEligibilityAssessment(database, {
        snapshotId,
        extractionId: `extraction-${applicationId}-${to}`,
        assessmentId,
        status: to === "hard_stopped" ? "blocked" : to,
      });
      transitionCommand.authorization.eligibilityAssessmentReference = assessmentId;
    }
    eventIds.push(
      applications.transition({
        applicationId,
        command: transitionCommand,
        reason: `Synthetic transition from ${from} to ${to}.`,
      }),
    );
  }
  return eventIds;
}

function eventCount(database: JobAgentDatabase, applicationId: string): number {
  return (
    connection(database)
      .prepare("SELECT count(*) AS count FROM application_events WHERE application_id = ?")
      .get(applicationId) as { count: number }
  ).count;
}

function driveToRejectedOutcome(
  database: JobAgentDatabase,
  suffix: string,
): { applications: ApplicationRepository; applicationId: string; rejectedEventId: string } {
  const { applications, applicationId } = createFixture(database, suffix);
  transitionPath(database, applications, applicationId, [
    "discovered",
    "normalized",
    "eligible",
    "shortlisted",
    "preparing",
    "ready_to_submit",
    "awaiting_approval",
  ]);
  connection(database).prepare("UPDATE automation_settings SET globally_paused = 0").run();
  connection(database)
    .prepare(
      `INSERT OR IGNORE INTO source_policies
       VALUES ((SELECT id FROM job_sources WHERE source_key = 'synthetic'), 1, 1, 1, 0, 1, ?)`,
    )
    .run("2026-01-01T00:00:00.000Z");
  applications.recordApproval({
    applicationId,
    kind: "human",
    approvedBy: "user",
    reference: `approval-${suffix}`,
  });
  applications.recordVerification({
    applicationId,
    reference: `verification-${suffix}`,
    result: "passed",
  });
  applications.transition({
    applicationId,
    command: {
      from: "awaiting_approval",
      to: "submitting",
      authorization: {
        automationMode: "assisted",
        actor: "agent",
        approval: { kind: "human", approvedBy: "user", reference: `approval-${suffix}` },
        verification: { result: "passed", reference: `verification-${suffix}` },
        sourceSubmissionAllowed: true,
        globalAutomationPaused: false,
        idempotencyKey: `submit-${suffix}`,
      },
    },
    reason: "Synthetic submission.",
  });
  applications.transition({
    applicationId,
    command: command("submitting", "submitted"),
    reason: "Synthetic receipt captured.",
  });
  const rejectedEventId = applications.transition({
    applicationId,
    command: command("submitted", "rejected"),
    reason: "Synthetic email classification.",
  });
  return { applications, applicationId, rejectedEventId };
}

function insertEligibilityAssessment(
  database: JobAgentDatabase,
  input: {
    snapshotId: string;
    extractionId: string;
    assessmentId: string;
    status: "eligible" | "blocked" | "needs_review";
  },
): void {
  const sqlite = connection(database);
  sqlite
    .prepare(
      `INSERT INTO requirement_extractions (
         id, job_snapshot_id, status, coverage_confidence, source_text_hash,
         extractor_name, extractor_version, created_at
       ) VALUES (?, ?, 'complete', 1.0, ?, 'synthetic-test', ?, ?)`,
    )
    .run(
      input.extractionId,
      input.snapshotId,
      `source-${input.extractionId}`,
      input.extractionId,
      "2026-01-01T00:00:00.000Z",
    );
  sqlite
    .prepare(
      `INSERT INTO eligibility_assessments (
         id, extraction_id, status, evaluator_version, created_at
       ) VALUES (?, ?, ?, 'test-v1', ?)` ,
    )
    .run(
      input.assessmentId,
      input.extractionId,
      input.status,
      "2026-01-01T00:00:00.000Z",
    );
}

describe("migrations and normalized constraints", () => {
  test("builds an empty database and records an immutable migration checksum", () => {
    const database = openMemoryDatabase();
    assert.equal("sqlite" in database, false);
    assert.equal("orm" in database, false);
    const migration = connection(database)
      .prepare("SELECT version, name, length(checksum) AS checksum_length FROM schema_migrations")
      .get() as { version: number; name: string; checksum_length: number };
    assert.deepEqual(migration, { version: 1, name: "initial", checksum_length: 64 });

    const foreignKeys = connection(database).pragma("foreign_keys", { simple: true });
    assert.equal(foreignKeys, 1);
  });

  test("rejects duplicate source identities and rolls the whole write back", () => {
    const database = openMemoryDatabase();
    const jobs = new JobRepository(database);
    const base = {
      sourceKey: "synthetic",
      sourceDisplayName: "Synthetic Source",
      sourceJobId: "duplicate-id",
      canonicalUrl: "https://example.invalid/jobs/duplicate-id",
      organizationName: "First Example Company",
      title: "Engineer",
      workplaceType: "remote" as const,
      descriptionText: "Synthetic description.",
      contentHash: "hash-one",
    };
    jobs.createWithSnapshot(base);
    assert.throws(() =>
      jobs.createWithSnapshot({
        ...base,
        canonicalUrl: "https://example.invalid/jobs/other-url",
        organizationName: "Rolled Back Company",
        contentHash: "hash-two",
      }));

    const counts = connection(database)
      .prepare(
        `SELECT
           (SELECT count(*) FROM jobs) AS jobs,
           (SELECT count(*) FROM job_snapshots) AS snapshots,
           (SELECT count(*) FROM organizations) AS organizations`,
      )
      .get();
    assert.deepEqual(counts, { jobs: 1, snapshots: 1, organizations: 1 });
  });

  test("orders migrations numerically and rejects duplicate versions and gaps", () => {
    const orderedDirectory = mkdtempSync(join(tmpdir(), "job-agent-migrations-"));
    temporaryDirectories.push(orderedDirectory);
    for (let version = 1; version <= 10; version += 1) {
      const prefix = version === 1
        ? "CREATE TABLE migration_order (version INTEGER NOT NULL);"
        : "";
      writeFileSync(
        join(orderedDirectory, `${version}_migration_${version}.sql`),
        `${prefix} INSERT INTO migration_order VALUES (${version});`,
      );
    }
    const ordered = new Database(":memory:");
    runMigrations(ordered, orderedDirectory);
    assert.deepEqual(
      ordered.prepare("SELECT version FROM migration_order").all(),
      Array.from({ length: 10 }, (_, index) => ({ version: index + 1 })),
    );
    ordered.close();

    const duplicateDirectory = mkdtempSync(join(tmpdir(), "job-agent-migrations-"));
    temporaryDirectories.push(duplicateDirectory);
    writeFileSync(join(duplicateDirectory, "1_first.sql"), "SELECT 1;");
    writeFileSync(join(duplicateDirectory, "01_duplicate.sql"), "SELECT 1;");
    const duplicate = new Database(":memory:");
    assert.throws(
      () => runMigrations(duplicate, duplicateDirectory),
      /Duplicate migration version 1/,
    );
    duplicate.close();

    const gapDirectory = mkdtempSync(join(tmpdir(), "job-agent-migrations-"));
    temporaryDirectories.push(gapDirectory);
    writeFileSync(join(gapDirectory, "1_first.sql"), "SELECT 1;");
    writeFileSync(join(gapDirectory, "3_third.sql"), "SELECT 3;");
    const gap = new Database(":memory:");
    assert.throws(
      () => runMigrations(gap, gapDirectory),
      /expected 2, found 3/,
    );
    gap.close();

    const invalidDirectory = mkdtempSync(join(tmpdir(), "job-agent-migrations-"));
    temporaryDirectories.push(invalidDirectory);
    writeFileSync(join(invalidDirectory, "1-invalid.sql"), "SELECT 1;");
    const invalid = new Database(":memory:");
    assert.throws(
      () => runMigrations(invalid, invalidDirectory),
      /must match <positive-version>_<name>\.sql/,
    );
    invalid.close();
  });

  test("rejects an unapplied migration below the highest applied version", () => {
    const directory = mkdtempSync(join(tmpdir(), "job-agent-migrations-"));
    temporaryDirectories.push(directory);
    writeFileSync(join(directory, "1_first.sql"), "SELECT 1;");
    writeFileSync(join(directory, "2_second.sql"), "SELECT 2;");
    const sqlite = new Database(":memory:");
    runMigrations(sqlite, directory);
    sqlite.prepare("DELETE FROM schema_migrations WHERE version = 1").run();
    assert.throws(
      () => runMigrations(sqlite, directory),
      /older than the highest applied version 2/,
    );
    sqlite.close();
  });

  test("rejects an applied migration whose file content or name changed", () => {
    const directory = mkdtempSync(join(tmpdir(), "job-agent-migrations-"));
    temporaryDirectories.push(directory);
    const original = "CREATE TABLE checksum_probe (id INTEGER PRIMARY KEY);";
    writeFileSync(join(directory, "1_first.sql"), original);
    const sqlite = new Database(":memory:");
    runMigrations(sqlite, directory);

    writeFileSync(
      join(directory, "1_first.sql"),
      "CREATE TABLE checksum_probe_edited (id INTEGER PRIMARY KEY);",
    );
    assert.throws(
      () => runMigrations(sqlite, directory),
      /Applied migration 1 differs from 1_first\.sql/,
    );

    rmSync(join(directory, "1_first.sql"));
    writeFileSync(join(directory, "1_renamed.sql"), original);
    assert.throws(
      () => runMigrations(sqlite, directory),
      /Applied migration 1 differs from 1_renamed\.sql/,
    );
    sqlite.close();
  });

  test("rejects migrations containing transaction-control statements before applying anything", () => {
    const directory = mkdtempSync(join(tmpdir(), "job-agent-migrations-"));
    temporaryDirectories.push(directory);
    writeFileSync(
      join(directory, "1_first.sql"),
      "-- COMMIT in a comment is fine\nCREATE TABLE txn_probe (note TEXT DEFAULT 'commit');",
    );
    writeFileSync(
      join(directory, "2_bad.sql"),
      "CREATE TABLE partial_commit (id INTEGER PRIMARY KEY); COMMIT; INSERT INTO missing_table VALUES (1);",
    );
    const sqlite = new Database(":memory:");
    assert.throws(
      () => runMigrations(sqlite, directory),
      /2_bad\.sql must not contain the transaction-control statement COMMIT/,
    );
    assert.deepEqual(
      sqlite
        .prepare("SELECT name FROM sqlite_master WHERE name IN ('txn_probe', 'partial_commit')")
        .all(),
      [],
    );
    assert.deepEqual(sqlite.prepare("SELECT version FROM schema_migrations").all(), []);

    writeFileSync(join(directory, "2_bad.sql"), "CREATE TABLE second (id INTEGER PRIMARY KEY); END;");
    assert.throws(
      () => runMigrations(sqlite, directory),
      /2_bad\.sql must not contain the transaction-control statement END/,
    );

    writeFileSync(
      join(directory, "2_bad.sql"),
      `CREATE TRIGGER txn_probe_guard
       BEFORE UPDATE ON txn_probe
       WHEN CASE WHEN OLD.note != NEW.note THEN 1 ELSE 0 END = 1
       BEGIN
         SELECT CASE WHEN 1 THEN RAISE(ABORT, 'txn_probe notes are frozen') END;
       END;`,
    );
    runMigrations(sqlite, directory);
    assert.deepEqual(
      sqlite.prepare("SELECT version FROM schema_migrations ORDER BY version").all(),
      [{ version: 1 }, { version: 2 }],
    );
    sqlite.close();
  });

  test("a failing migration leaves neither partial schema objects nor a ledger row", () => {
    const directory = mkdtempSync(join(tmpdir(), "job-agent-migrations-"));
    temporaryDirectories.push(directory);
    writeFileSync(join(directory, "1_first.sql"), "CREATE TABLE stable (id INTEGER PRIMARY KEY);");
    writeFileSync(
      join(directory, "2_broken.sql"),
      "CREATE TABLE partial_object (id INTEGER PRIMARY KEY); INSERT INTO missing_table VALUES (1);",
    );
    const sqlite = new Database(":memory:");
    assert.throws(() => runMigrations(sqlite, directory), /missing_table/);
    assert.deepEqual(
      sqlite
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE name IN ('stable', 'partial_object') ORDER BY name`,
        )
        .all(),
      [{ name: "stable" }],
    );
    assert.deepEqual(
      sqlite.prepare("SELECT version FROM schema_migrations ORDER BY version").all(),
      [{ version: 1 }],
    );

    writeFileSync(
      join(directory, "2_broken.sql"),
      "CREATE TABLE partial_object (id INTEGER PRIMARY KEY);",
    );
    runMigrations(sqlite, directory);
    assert.deepEqual(
      sqlite.prepare("SELECT version FROM schema_migrations ORDER BY version").all(),
      [{ version: 1 }, { version: 2 }],
    );
    sqlite.close();
  });

  test("the populated relational graph passes PRAGMA foreign_key_check with zero rows", () => {
    const database = openMemoryDatabase();
    const { applications, applicationId } = createFixture(database, "fk-check");
    transitionPath(database, applications, applicationId, [
      "discovered",
      "normalized",
      "eligible",
    ]);
    const sqlite = connection(database);
    sqlite.prepare(
      `INSERT INTO requirements (
         id, extraction_id, requirement_ordinal, requirement_text, category,
         fulfillment, mandatory, classification_confidence, explanation
       ) VALUES ('fk-requirement', ?, 0, 'Synthetic requirement',
                 'skill', 'satisfied', 0, 1.0, 'Synthetic evidence.')`,
    ).run(`extraction-${applicationId}-eligible`);
    sqlite.prepare(
      `INSERT INTO requirement_assessments (
         id, eligibility_assessment_id, requirement_id, extraction_id, severity, explanation
       ) VALUES ('fk-req-assessment', ?, 'fk-requirement', ?, 'satisfied', 'Synthetic assessment.')`,
    ).run(`assessment-${applicationId}-eligible`, `extraction-${applicationId}-eligible`);
    assert.deepEqual(sqlite.pragma("foreign_key_check"), []);
  });

  test("an application cannot pin or re-pin a snapshot outside its own job", () => {
    const database = openMemoryDatabase();
    const first = createFixture(database, "pin-a");
    const second = createFixture(database, "pin-b");
    const sqlite = connection(database);
    const foreignSnapshotId = (
      sqlite.prepare("SELECT id FROM job_snapshots WHERE job_id = ?").get(second.jobId) as {
        id: string;
      }
    ).id;

    assert.throws(
      () => sqlite.prepare(
        `INSERT INTO applications (
           id, job_id, job_snapshot_id, attempt_number, current_state,
           automation_mode, created_at, updated_at
         ) VALUES ('cross-pin', ?, ?, 2, 'skipped', 'assisted',
                   '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      ).run(first.jobId, foreignSnapshotId),
      /FOREIGN KEY constraint failed/,
    );
    assert.throws(
      () => sqlite.prepare("UPDATE applications SET job_snapshot_id = ? WHERE id = ?")
        .run(foreignSnapshotId, first.applicationId),
      /allow only current_state, automation_mode, and updated_at updates/,
    );
    assert.deepEqual(
      sqlite.prepare("SELECT count(*) AS count FROM applications").get(),
      { count: 2 },
    );
  });

  test("prevents requirement assessments from crossing extraction boundaries", () => {
    const database = openMemoryDatabase();
    createFixture(database);
    const sqlite = connection(database);
    const snapshotId = (sqlite.prepare("SELECT id FROM job_snapshots LIMIT 1").get() as { id: string }).id;
    insertEligibilityAssessment(database, {
      snapshotId,
      extractionId: "extraction-a",
      assessmentId: "assessment-a",
      status: "eligible",
    });
    insertEligibilityAssessment(database, {
      snapshotId,
      extractionId: "extraction-b",
      assessmentId: "assessment-b",
      status: "eligible",
    });
    sqlite.prepare(
      `INSERT INTO requirements (
         id, extraction_id, requirement_ordinal, requirement_text, category,
         fulfillment, mandatory, classification_confidence, explanation
       ) VALUES ('requirement-b', 'extraction-b', 0, 'Synthetic requirement',
                 'skill', 'satisfied', 0, 1.0, 'Synthetic evidence.')`,
    ).run();
    assert.throws(() => sqlite.prepare(
      `INSERT INTO requirement_assessments (
         id, eligibility_assessment_id, requirement_id, extraction_id, severity, explanation
       ) VALUES ('crossed', 'assessment-a', 'requirement-b', 'extraction-a',
                 'satisfied', 'Invalid cross-extraction relation.')`,
    ).run(), /FOREIGN KEY constraint failed/);
  });
});

describe("application event transactions", () => {
  test("enforces append-only events and immutable approval and verification evidence", () => {
    const database = openMemoryDatabase();
    const { applications, applicationId } = createFixture(database);
    applications.recordApproval({
      applicationId,
      kind: "human",
      approvedBy: "user",
      reference: "immutable-approval",
    });
    applications.recordVerification({
      applicationId,
      reference: "immutable-verification",
      result: "passed",
    });
    const sqlite = connection(database);
    const snapshotId = (
      sqlite.prepare("SELECT job_snapshot_id FROM applications WHERE id = ?")
        .get(applicationId) as { job_snapshot_id: string }
    ).job_snapshot_id;
    insertEligibilityAssessment(database, {
      snapshotId,
      extractionId: "immutable-extraction",
      assessmentId: "immutable-assessment",
      status: "eligible",
    });

    assert.throws(
      () => sqlite.prepare(
        "UPDATE application_events SET to_state = 'offer' WHERE application_id = ?",
      ).run(applicationId),
      /application_events are append-only/,
    );
    assert.throws(
      () => sqlite.prepare("DELETE FROM application_events WHERE application_id = ?")
        .run(applicationId),
      /application_events are append-only/,
    );
    assert.throws(
      () => sqlite.prepare(
        "UPDATE application_approvals SET approved_by = 'system' WHERE application_id = ?",
      ).run(applicationId),
      /application_approvals are immutable evidence/,
    );
    assert.throws(
      () => sqlite.prepare("DELETE FROM verification_results WHERE application_id = ?")
        .run(applicationId),
      /verification_results are immutable evidence/,
    );
    assert.throws(
      () => sqlite.prepare(
        "UPDATE eligibility_assessments SET status = 'blocked' WHERE id = ?",
      ).run("immutable-assessment"),
      /eligibility_assessments are immutable evidence/,
    );

    sqlite.prepare(
      `INSERT INTO requirements (
         id, extraction_id, requirement_ordinal, requirement_text, category,
         fulfillment, mandatory, classification_confidence, explanation
       ) VALUES ('immutable-requirement', 'immutable-extraction', 0, 'Synthetic requirement',
                 'skill', 'satisfied', 0, 1.0, 'Synthetic evidence.')`,
    ).run();
    sqlite.prepare(
      `INSERT INTO requirement_assessments (
         id, eligibility_assessment_id, requirement_id, extraction_id, severity, explanation
       ) VALUES ('immutable-req-assessment', 'immutable-assessment', 'immutable-requirement',
                 'immutable-extraction', 'satisfied', 'Synthetic assessment.')`,
    ).run();
    sqlite.prepare(
      `INSERT INTO audit_events (id, application_id, event_name, actor, occurred_at)
       VALUES ('immutable-audit', ?, 'synthetic_audit', 'system', '2026-01-01T00:00:00.000Z')`,
    ).run(applicationId);

    assert.throws(
      () => sqlite.prepare("UPDATE requirements SET fulfillment = 'missing' WHERE id = 'immutable-requirement'").run(),
      /requirements are immutable evidence/,
    );
    assert.throws(
      () => sqlite.prepare("DELETE FROM requirement_assessments WHERE id = 'immutable-req-assessment'").run(),
      /requirement_assessments are immutable evidence/,
    );
    assert.throws(
      () => sqlite.prepare("DELETE FROM requirement_extractions WHERE id = 'immutable-extraction'").run(),
      /requirement_extractions are immutable evidence/,
    );
    assert.throws(
      () => sqlite.prepare("UPDATE audit_events SET event_name = 'edited' WHERE id = 'immutable-audit'").run(),
      /audit_events are append-only/,
    );
    assert.throws(
      () => sqlite.prepare("DELETE FROM audit_events WHERE id = 'immutable-audit'").run(),
      /audit_events are append-only/,
    );

    assert.equal(applications.rebuildCurrentState(applicationId), "discovered");
    assert.deepEqual(
      sqlite.prepare("SELECT current_state FROM applications WHERE id = ?").get(applicationId),
      { current_state: "discovered" },
    );
  });

  test("invalid transitions create neither an event nor a projection update", () => {
    const database = openMemoryDatabase();
    const { applications, applicationId } = createFixture(database);

    assert.throws(() =>
      applications.transition({
        applicationId,
        command: command("discovered", "submitted"),
        reason: "This transition is intentionally invalid.",
      }), /Invalid application transition/);

    const application = connection(database)
      .prepare("SELECT current_state FROM applications WHERE id = ?")
      .get(applicationId);
    const eventCount = connection(database)
      .prepare("SELECT count(*) AS count FROM application_events WHERE application_id = ?")
      .get(applicationId);
    assert.deepEqual(application, { current_state: "discovered" });
    assert.deepEqual(eventCount, { count: 1 });
  });

  test("rebuilds the current-state projection from its contiguous event stream", () => {
    const database = openMemoryDatabase();
    const { applications, applicationId } = createFixture(database);
    transitionPath(database, applications, applicationId, [
      "discovered",
      "normalized",
      "eligible",
      "shortlisted",
      "preparing",
      "ready_to_submit",
      "awaiting_approval",
    ]);
    assert.equal(applications.rebuildCurrentState(applicationId), "awaiting_approval");
  });

  test("rejects fabricated or unrelated eligibility evidence references", () => {
    const database = openMemoryDatabase();
    const { applications, applicationId } = createFixture(database, "eligibility-main");
    applications.transition({
      applicationId,
      command: command("discovered", "normalized"),
      reason: "Synthetic normalization.",
    });
    const inventedInitialDecision = command("normalized", "eligible");
    inventedInitialDecision.authorization.eligibilityAssessmentReference =
      "invented-initial-assessment";
    assert.throws(
      () => applications.transition({
        applicationId,
        command: inventedInitialDecision,
        reason: "Synthetic invented initial decision.",
      }),
      /must exist for this application's posting snapshot/,
    );
    transitionPath(database, applications, applicationId, [
      "normalized",
      "needs_review",
    ]);
    const reviewResolution = (
      eligibilityAssessmentReference: string,
    ): ApplicationTransitionCommand => ({
      from: "needs_review",
      to: "eligible",
      authorization: {
        automationMode: "assisted",
        actor: "user",
        verification: { result: "not_run" },
        sourceSubmissionAllowed: false,
        globalAutomationPaused: true,
        eligibilityAssessmentReference,
        resolvedCandidateFactReferences: ["invented-candidate-fact"],
      },
    });

    assert.throws(
      () => applications.transition({
        applicationId,
        command: reviewResolution("invented-assessment"),
        reason: "Synthetic review resolution.",
      }),
      /must exist for this application's posting snapshot/,
    );

    const unrelated = createFixture(database, "eligibility-unrelated");
    const unrelatedSnapshotId = (
      connection(database)
        .prepare("SELECT job_snapshot_id FROM applications WHERE id = ?")
        .get(unrelated.applicationId) as { job_snapshot_id: string }
    ).job_snapshot_id;
    insertEligibilityAssessment(database, {
      snapshotId: unrelatedSnapshotId,
      extractionId: "unrelated-extraction",
      assessmentId: "unrelated-eligible-assessment",
      status: "eligible",
    });
    assert.throws(
      () => applications.transition({
        applicationId,
        command: reviewResolution("unrelated-eligible-assessment"),
        reason: "Synthetic unrelated review resolution.",
      }),
      /must exist for this application's posting snapshot/,
    );

    const snapshotId = (
      connection(database)
        .prepare("SELECT job_snapshot_id FROM applications WHERE id = ?")
        .get(applicationId) as { job_snapshot_id: string }
    ).job_snapshot_id;
    insertEligibilityAssessment(database, {
      snapshotId,
      extractionId: "matching-extraction",
      assessmentId: "matching-eligible-assessment",
      status: "eligible",
    });
    assert.throws(
      () => applications.transition({
        applicationId,
        command: reviewResolution("matching-eligible-assessment"),
        reason: "Synthetic unresolved candidate fact.",
      }),
      /candidate facts have a persisted, verifiable ledger/i,
    );
  });

  test("allows review to hard-stop only with a matching blocked assessment", () => {
    const database = openMemoryDatabase();
    const { applications, applicationId } = createFixture(database, "blocked-review");
    transitionPath(database, applications, applicationId, [
      "discovered",
      "normalized",
      "needs_review",
    ]);
    const snapshotId = (
      connection(database)
        .prepare("SELECT job_snapshot_id FROM applications WHERE id = ?")
        .get(applicationId) as { job_snapshot_id: string }
    ).job_snapshot_id;
    insertEligibilityAssessment(database, {
      snapshotId,
      extractionId: "blocked-extraction",
      assessmentId: "blocked-assessment",
      status: "blocked",
    });
    applications.transition({
      applicationId,
      command: {
        from: "needs_review",
        to: "hard_stopped",
        authorization: {
          automationMode: "assisted",
          actor: "system",
          verification: { result: "not_run" },
          sourceSubmissionAllowed: false,
          globalAutomationPaused: true,
          eligibilityAssessmentReference: "blocked-assessment",
        },
      },
      reason: "Synthetic assessment verified a hard stop.",
    });
    assert.equal(applications.rebuildCurrentState(applicationId), "hard_stopped");
  });

  test("requires persisted approval, verification, settings, and source policy", () => {
    const database = openMemoryDatabase();
    const { applications, applicationId } = createFixture(database);
    transitionPath(database, applications, applicationId, [
      "discovered",
      "normalized",
      "eligible",
      "shortlisted",
      "preparing",
      "ready_to_submit",
      "awaiting_approval",
    ]);

    connection(database).prepare("UPDATE automation_settings SET globally_paused = 0").run();
    connection(database)
      .prepare(
        `INSERT INTO source_policies (
           source_id, discovery_allowed, detail_retrieval_allowed,
           assisted_submission_allowed, autonomous_submission_allowed,
           outcome_sync_allowed, updated_at
         ) SELECT id, 1, 1, 1, 0, 1, ? FROM job_sources WHERE source_key = 'synthetic'`,
      )
      .run("2026-01-01T00:00:00.000Z");
    applications.recordApproval({
      applicationId,
      kind: "human",
      approvedBy: "user",
      reference: "approval-001",
    });
    applications.recordVerification({
      applicationId,
      reference: "verification-001",
      result: "passed",
    });

    const submission: ApplicationTransitionCommand = {
      from: "awaiting_approval",
      to: "submitting",
      authorization: {
        automationMode: "assisted",
        actor: "agent",
        approval: { kind: "human", approvedBy: "user", reference: "approval-001" },
        verification: { result: "passed", reference: "verification-001" },
        sourceSubmissionAllowed: true,
        globalAutomationPaused: false,
        idempotencyKey: "submit-001",
      },
    };
    applications.transition({
      applicationId,
      command: submission,
      reason: "Synthetic approved submission.",
    });
    assert.equal(applications.rebuildCurrentState(applicationId), "submitting");
  });

  test("keeps the projection unchanged when a submission idempotency key is reused", () => {
    const database = openMemoryDatabase();
    const { applications, applicationId } = createFixture(database);
    transitionPath(database, applications, applicationId, [
      "discovered",
      "normalized",
      "eligible",
      "shortlisted",
      "preparing",
      "ready_to_submit",
      "awaiting_approval",
    ]);
    connection(database).prepare("UPDATE automation_settings SET globally_paused = 0").run();
    connection(database)
      .prepare(
        `INSERT INTO source_policies
         VALUES ((SELECT id FROM job_sources WHERE source_key = 'synthetic'), 1, 1, 1, 0, 1, ?)`,
      )
      .run("2026-01-01T00:00:00.000Z");
    applications.recordApproval({
      applicationId,
      kind: "human",
      approvedBy: "user",
      reference: "approval-retry",
    });
    applications.recordVerification({
      applicationId,
      reference: "verification-retry",
      result: "passed",
    });
    const submitting: ApplicationTransitionCommand = {
      from: "awaiting_approval",
      to: "submitting",
      authorization: {
        automationMode: "assisted",
        actor: "agent",
        approval: { kind: "human", approvedBy: "user", reference: "approval-retry" },
        verification: { result: "passed", reference: "verification-retry" },
        sourceSubmissionAllowed: true,
        globalAutomationPaused: false,
        idempotencyKey: "stable-submit-key",
      },
    };
    applications.transition({ applicationId, command: submitting, reason: "First attempt." });
    applications.transition({
      applicationId,
      command: command("submitting", "submission_failed"),
      reason: "Synthetic network failure.",
    });
    const eventsBefore = eventCount(database, applicationId);
    assert.throws(() =>
      applications.transition({
        applicationId,
        command: { ...submitting, from: "submission_failed" },
        reason: "Duplicate retry.",
      }));

    const state = connection(database)
      .prepare("SELECT current_state FROM applications WHERE id = ?")
      .get(applicationId);
    assert.deepEqual(state, { current_state: "submission_failed" });
    assert.equal(eventCount(database, applicationId), eventsBefore);
  });

  test("appends a compensating outcome event instead of rewriting history", () => {
    const database = openMemoryDatabase();
    const { applications, applicationId, rejectedEventId } = driveToRejectedOutcome(
      database,
      "outcome",
    );
    applications.correctOutcome({
      applicationId,
      command: {
        from: "rejected",
        to: "offer",
        actor: "user",
        supersededEventId: rejectedEventId,
        reason: "User verified that the message was an offer.",
      },
    });

    const correction = connection(database)
      .prepare(
        `SELECT event_type, supersedes_event_id, to_state FROM application_events
         WHERE application_id = ? ORDER BY sequence_number DESC LIMIT 1`,
      )
      .get(applicationId);
    assert.deepEqual(correction, {
      event_type: "outcome_corrected",
      supersedes_event_id: rejectedEventId,
      to_state: "offer",
    });
    assert.equal(applications.rebuildCurrentState(applicationId), "offer");

    assert.throws(
      () => connection(database).prepare(
        `INSERT INTO application_events (
           id, application_id, sequence_number, event_type, actor, from_state,
           to_state, occurred_at, reason, supersedes_event_id, payload_json
         ) VALUES ('duplicate-correction', ?, 12, 'outcome_corrected', 'user',
                   'offer', 'rejected', ?, 'Forked correction.', ?, '{}')`,
      ).run(applicationId, "2026-01-02T00:00:00.000Z", rejectedEventId),
      /UNIQUE constraint failed: application_events.supersedes_event_id/,
    );

    const eventsBeforeRejection = eventCount(database, applicationId);
    assert.throws(
      () => applications.correctOutcome({
        applicationId,
        command: {
          from: "offer",
          to: "rejected",
          actor: "user",
          supersededEventId: rejectedEventId,
          reason: "Attempt to fork correction history.",
        },
      }),
      /latest effective outcome event/,
    );
    assert.equal(applications.rebuildCurrentState(applicationId), "offer");
    assert.equal(eventCount(database, applicationId), eventsBeforeRejection);
  });

  test("rejects an outcome correction referencing another application's event", () => {
    const database = openMemoryDatabase();
    const first = driveToRejectedOutcome(database, "cross-a");
    const second = driveToRejectedOutcome(database, "cross-b");

    const eventsBefore = eventCount(database, first.applicationId);
    assert.throws(
      () => first.applications.correctOutcome({
        applicationId: first.applicationId,
        command: {
          from: "rejected",
          to: "offer",
          actor: "user",
          supersededEventId: second.rejectedEventId,
          reason: "Cross-application correction attempt.",
        },
      }),
      /latest effective outcome event/,
    );
    assert.equal(eventCount(database, first.applicationId), eventsBefore);
    assert.deepEqual(
      connection(database)
        .prepare("SELECT current_state FROM applications WHERE id = ?")
        .get(first.applicationId),
      { current_state: "rejected" },
    );
    assert.equal(first.applications.rebuildCurrentState(first.applicationId), "rejected");
  });
});

test("a failed openDatabase closes its connection instead of leaking it", () => {
  const directory = mkdtempSync(join(tmpdir(), "us-job-agent-db-test-"));
  temporaryDirectories.push(directory);
  const filename = join(directory, "agent.sqlite");
  const database = openDatabase({ filename });
  getDatabaseConnection(database)
    .prepare("UPDATE schema_migrations SET checksum = 'tampered'")
    .run();
  database.close();

  assert.throws(() => openDatabase({ filename }), /Applied migration 1 differs from/);
  // On Windows an open handle would make this delete fail with EBUSY/EPERM.
  rmSync(filename);
});

test("synthetic data survives closing and reopening a file database", () => {
  const directory = mkdtempSync(join(tmpdir(), "us-job-agent-db-test-"));
  temporaryDirectories.push(directory);
  const filename = join(directory, "agent.sqlite");
  const first = openDatabase({ filename });
  const seeded = seedSyntheticData(first);
  assert.deepEqual(seedSyntheticData(first), seeded);
  assert.deepEqual(connection(first).prepare("SELECT count(*) AS count FROM jobs").get(), {
    count: 4,
  });
  first.close();

  const second = openDatabase({ filename });
  openDatabases.push(second);
  const application = connection(second)
    .prepare("SELECT job_id, current_state FROM applications WHERE id = ?")
    .get(seeded.applicationId);
  assert.deepEqual(application, { job_id: seeded.jobId, current_state: "shortlisted" });
});

test("the seed upgrades a Phase 1C-shaped database to the full synthetic workspace", () => {
  const database = openMemoryDatabase();

  // Recreate exactly what the Phase 1C seed left behind: one automotive job
  // with one snapshot and one application still in 'discovered', and nothing
  // else — no assessments, no review items, no other jobs.
  const description =
    "Synthetic automotive systems role. Five years requested; training and transferable projects welcomed.";
  const { jobId } = new JobRepository(database).createWithSnapshot({
    sourceKey: "synthetic",
    sourceDisplayName: "Synthetic Development Source",
    sourceJobId: "synthetic-automotive-001",
    canonicalUrl: "https://example.invalid/jobs/synthetic-automotive-001",
    organizationName: "Example Mobility Labs",
    title: "Automotive Systems Engineer",
    locationText: "Detroit, MI",
    workplaceType: "hybrid",
    employmentType: "full-time",
    descriptionText: description,
    contentHash: createHash("sha256").update(description).digest("hex"),
    now: "2026-01-01T00:00:00.000Z",
  });
  const applicationId = new ApplicationRepository(database).create({
    jobId,
    automationMode: "assisted",
    now: "2026-01-01T00:00:00.000Z",
  });

  // The convergent seed must adopt the existing records and top the
  // workspace up instead of returning early with the old minimal shape.
  const seeded = seedSyntheticData(database);
  assert.deepEqual(seeded, { jobId, applicationId });

  const count = (table: string) =>
    (
      connection(database).prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
        count: number;
      }
    ).count;
  assert.equal(count("jobs"), 4);
  assert.equal(count("eligibility_assessments"), 3);
  assert.equal(count("review_items"), 1);
  assert.deepEqual(
    connection(database)
      .prepare("SELECT current_state FROM applications WHERE id = ?")
      .get(applicationId),
    { current_state: "shortlisted" },
    "the pre-existing application is advanced through the seeded transitions",
  );

  // Still idempotent after the upgrade.
  assert.deepEqual(seedSyntheticData(database), seeded);
  assert.equal(count("jobs"), 4);
  assert.equal(count("review_items"), 1);
});
