import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, test } from "node:test";
import {
  DiscoveryFailureError,
  type RawDiscoveryOutput,
  type RawPosting,
  type SourceAdapter,
  type SourceCapabilities,
} from "@us-job-agent/domain/discovery";
import Database from "better-sqlite3";
import { DiscoveryRepository, openDatabase, runDiscovery } from "../src/index.ts";
import { getDatabaseConnection } from "../src/database-internal.ts";
import { runMigrations } from "../src/migrations.ts";
import type { JobAgentDatabase } from "../src/database.ts";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../migrations");

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

function unpause(database: JobAgentDatabase): void {
  connection(database).prepare("UPDATE automation_settings SET globally_paused = 0").run();
}

const discoveryOnly: SourceCapabilities = {
  discovery: true,
  detailRetrieval: false,
  assistedSubmission: false,
  autonomousSubmission: false,
  outcomeSync: false,
};

function registerSource(
  database: JobAgentDatabase,
  sourceKey: string,
  options: { graceSeconds?: number; enabled?: boolean; now?: string } = {},
): DiscoveryRepository {
  const repository = new DiscoveryRepository(database);
  repository.registerSource({
    sourceKey,
    displayName: `Fake ${sourceKey}`,
    capabilities: discoveryOnly,
    expirationGraceSeconds: options.graceSeconds ?? 0,
    // New sources default disabled; these ingestion tests want the source live,
    // so enable it unless a test explicitly disables.
    enabled: options.enabled ?? true,
    now: options.now ?? "2026-01-01T00:00:00.000Z",
  });
  return repository;
}

/** A fake adapter that records whether it was executed. */
function fakeAdapter(
  key: string,
  output: RawDiscoveryOutput | (() => RawDiscoveryOutput | Promise<RawDiscoveryOutput>),
): SourceAdapter & { calls: number } {
  const adapter = {
    key,
    displayName: `Fake ${key}`,
    capabilities: discoveryOnly,
    calls: 0,
    discover() {
      adapter.calls += 1;
      return typeof output === "function" ? output() : output;
    },
  };
  return adapter;
}

const samplePosting: RawPosting = {
  sourceJobId: "req-100",
  url: "https://boards.example.com/acme/jobs/100",
  title: "Platform Engineer",
  company: "Acme Corp",
  location: "Detroit, MI",
  workplaceType: "remote",
  employmentType: "Full-time",
  descriptionText: "Own the deployment platform.",
};

function count(database: JobAgentDatabase, table: string, where = ""): number {
  return (
    connection(database)
      .prepare(`SELECT COUNT(*) AS c FROM ${table} ${where}`)
      .get() as { c: number }
  ).c;
}

describe("discovery ingestion", () => {
  test("re-seeing the same source posting updates last-seen without duplicating the job", async () => {
    const database = openMemoryDatabase();
    unpause(database);
    registerSource(database, "greenhouse");
    const adapter = fakeAdapter("greenhouse", {
      authoritative: true,
      postings: [samplePosting],
    });

    await runDiscovery(database, adapter, { now: "2026-02-01T00:00:00.000Z", authoritative: true });
    await runDiscovery(database, adapter, { now: "2026-02-02T00:00:00.000Z", authoritative: true });

    assert.equal(count(database, "jobs"), 1);
    assert.equal(count(database, "job_snapshots"), 1);
    assert.equal(count(database, "posting_observations"), 2);
    const job = connection(database)
      .prepare("SELECT last_seen_at FROM jobs")
      .get() as { last_seen_at: string };
    assert.equal(job.last_seen_at, "2026-02-02T00:00:00.000Z");
  });

  test("identical content adds no snapshot; changed content adds exactly one", async () => {
    const database = openMemoryDatabase();
    unpause(database);
    registerSource(database, "greenhouse");

    const run = (description: string, now: string) =>
      runDiscovery(
        database,
        fakeAdapter("greenhouse", {
          authoritative: true,
          postings: [{ ...samplePosting, descriptionText: description }],
        }),
        { now, authoritative: true },
      );

    await run("Original scope.", "2026-03-01T00:00:00.000Z");
    await run("Changed scope.", "2026-03-02T00:00:00.000Z");
    await run("Changed scope.", "2026-03-03T00:00:00.000Z"); // identical to previous

    assert.equal(count(database, "jobs"), 1);
    assert.equal(count(database, "job_snapshots"), 2);
    // Exactly one observation flagged content_changed per genuine change.
    assert.equal(count(database, "posting_observations", "WHERE content_changed = 1"), 2);
  });

  test("same-source canonical-URL match deduplicates across differing source ids", async () => {
    const database = openMemoryDatabase();
    unpause(database);
    registerSource(database, "greenhouse");

    await runDiscovery(
      database,
      fakeAdapter("greenhouse", { authoritative: true, postings: [samplePosting] }),
      { now: "2026-04-01T00:00:00.000Z", authoritative: true },
    );
    // Same source, same canonical URL, different source job id, in a later run.
    await runDiscovery(
      database,
      fakeAdapter("greenhouse", {
        authoritative: true,
        postings: [{ ...samplePosting, sourceJobId: "req-999" }],
      }),
      { now: "2026-04-02T00:00:00.000Z", authoritative: true },
    );

    assert.equal(count(database, "jobs"), 1);
  });

  test("a cross-source canonical collision is recorded and skipped, never merged", async () => {
    const database = openMemoryDatabase();
    unpause(database);
    registerSource(database, "greenhouse");
    registerSource(database, "lever");

    // Greenhouse owns the URL first.
    const g = await runDiscovery(
      database,
      fakeAdapter("greenhouse", { authoritative: true, postings: [samplePosting] }),
      { now: "2026-04-10T00:00:00.000Z", authoritative: true },
    );
    // Lever reports the same canonical URL under its own id.
    const l = await runDiscovery(
      database,
      fakeAdapter("lever", {
        authoritative: true,
        postings: [{ ...samplePosting, sourceJobId: "lever-1" }],
      }),
      { now: "2026-04-11T00:00:00.000Z", authoritative: true },
    );

    // Dropping source data must not read as a clean success. Partial status is
    // what blocks expiration (finishRun expires only on 'succeeded').
    assert.equal(l.status, "partial");
    assert.equal(l.postings.length, 0);
    assert.equal(
      count(database, "discovery_run_failures", "WHERE category = 'cross_source_duplicate'"),
      1,
    );

    // Still one job, still owned by greenhouse; lever's run did NOT overwrite
    // the job's last-seen ownership.
    assert.equal(count(database, "jobs"), 1);
    const state = connection(database)
      .prepare(
        `SELECT jds.last_seen_run_id, s.source_key
         FROM job_discovery_state jds
         JOIN job_sources s ON s.id = jds.source_id`,
      )
      .get() as { last_seen_run_id: string; source_key: string };
    assert.equal(state.source_key, "greenhouse");
    assert.equal(state.last_seen_run_id, g.runId);
    // The collision is inspectable in the audit log.
    assert.equal(
      count(
        database,
        "audit_events",
        "WHERE event_name = 'discovery_cross_source_canonical_skipped'",
      ),
      1,
    );
  });

  test("cross-source fingerprint matches are recorded, never merged; ambiguity is flagged", async () => {
    const database = openMemoryDatabase();
    unpause(database);
    const sameRole = {
      title: "Data Scientist",
      company: "Globex",
      location: "Austin, TX",
      descriptionText: "Model things.",
    };

    for (const [source, id, host, now] of [
      ["greenhouse", "g-1", "greenhouse", "2026-05-01T00:00:00.000Z"],
      ["lever", "l-1", "lever", "2026-05-02T00:00:00.000Z"],
      ["ashby", "a-1", "ashby", "2026-05-03T00:00:00.000Z"],
    ] as const) {
      registerSource(database, source);
      await runDiscovery(
        database,
        fakeAdapter(source, {
          authoritative: true,
          postings: [{ ...sameRole, sourceJobId: id, url: `https://${host}.example.com/j/${id}` }],
        }),
        { now, authoritative: true },
      );
    }

    // Three separate jobs — fingerprint never merges.
    assert.equal(count(database, "jobs"), 3);
    // Second job links to the first as a candidate; third sees two ⇒ ambiguous.
    assert.equal(count(database, "job_duplicate_links", "WHERE status = 'candidate'"), 1);
    assert.equal(count(database, "job_duplicate_links", "WHERE status = 'ambiguous'"), 2);
  });

  test("a malformed posting is classified, ingests nothing, and downgrades the run", async () => {
    const database = openMemoryDatabase();
    unpause(database);
    registerSource(database, "greenhouse");
    const result = await runDiscovery(
      database,
      fakeAdapter("greenhouse", {
        authoritative: true,
        postings: [
          samplePosting,
          { ...samplePosting, sourceJobId: null, url: "not-a-url", title: "" },
        ],
      }),
      { now: "2026-06-01T00:00:00.000Z", authoritative: true },
    );
    assert.equal(result.status, "partial");
    assert.equal(count(database, "jobs"), 1);
    assert.equal(count(database, "discovery_run_failures", "WHERE category = 'schema'"), 1);
  });

  test("a duplicate ingest within one run rolls back atomically", async () => {
    const database = openMemoryDatabase();
    unpause(database);
    const repository = registerSource(database, "greenhouse");
    const runId = repository.startRun({
      sourceKey: "greenhouse",
      authoritative: true,
      trigger: "test",
      now: "2026-07-01T00:00:00.000Z",
    });
    const normalized = {
      sourceJobId: "req-1",
      canonicalUrl: "https://x.example.com/j/1",
      title: "Engineer",
      company: "Acme",
      locationText: "Detroit",
      workplaceType: "remote" as const,
      employmentType: null,
      descriptionText: "Work.",
      postedAt: null,
      closesAt: null,
      contentHash: "hash-1",
      fingerprint: "fp-1",
    };
    repository.ingestPosting(runId, normalized, "2026-07-01T00:00:00.000Z");
    const before = {
      jobs: count(database, "jobs"),
      snapshots: count(database, "job_snapshots"),
      observations: count(database, "posting_observations"),
    };
    // Same (run, job): the observation UNIQUE constraint fails and the whole
    // posting's writes roll back.
    assert.throws(() =>
      repository.ingestPosting(runId, normalized, "2026-07-01T00:00:00.000Z"),
    );
    assert.deepEqual(
      {
        jobs: count(database, "jobs"),
        snapshots: count(database, "job_snapshots"),
        observations: count(database, "posting_observations"),
      },
      before,
    );
  });
});

describe("discovery expiration", () => {
  async function seedTwoJobs(database: JobAgentDatabase, source: string, graceSeconds = 0) {
    registerSource(database, source, { graceSeconds });
    await runDiscovery(
      database,
      fakeAdapter(source, {
        authoritative: true,
        postings: [
          { ...samplePosting, sourceJobId: "a", url: "https://x.example.com/a" },
          { ...samplePosting, sourceJobId: "b", url: "https://x.example.com/b" },
        ],
      }),
      { now: "2026-08-01T00:00:00.000Z", authoritative: true },
    );
  }

  test("a failed run never expires unseen jobs", async () => {
    const database = openMemoryDatabase();
    unpause(database);
    await seedTwoJobs(database, "greenhouse");

    const result = await runDiscovery(
      database,
      fakeAdapter("greenhouse", () => {
        throw new DiscoveryFailureError("network");
      }),
      { now: "2026-08-05T00:00:00.000Z", authoritative: true },
    );
    assert.equal(result.status, "failed");
    assert.equal(count(database, "job_discovery_state", "WHERE expired = 1"), 0);
  });

  test("a partial run never expires unseen jobs", async () => {
    const database = openMemoryDatabase();
    unpause(database);
    await seedTwoJobs(database, "greenhouse");

    // Authoritative run that sees only job A plus a failure ⇒ partial.
    const result = await runDiscovery(
      database,
      fakeAdapter("greenhouse", {
        authoritative: true,
        postings: [{ ...samplePosting, sourceJobId: "a", url: "https://x.example.com/a" }],
        failures: [{ category: "rate_limited", message: "The source rate-limited the request." }],
      }),
      { now: "2026-08-06T00:00:00.000Z", authoritative: true },
    );
    assert.equal(result.status, "partial");
    assert.equal(count(database, "job_discovery_state", "WHERE expired = 1"), 0);
  });

  test("a successful authoritative run expires jobs unseen beyond the grace period", async () => {
    const database = openMemoryDatabase();
    unpause(database);
    await seedTwoJobs(database, "greenhouse", 0);

    // Authoritative success seeing only A ⇒ B is unseen and (grace 0) expires.
    await runDiscovery(
      database,
      fakeAdapter("greenhouse", {
        authoritative: true,
        postings: [{ ...samplePosting, sourceJobId: "a", url: "https://x.example.com/a" }],
      }),
      { now: "2026-08-10T00:00:00.000Z", authoritative: true },
    );
    const expired = connection(database)
      .prepare("SELECT job_id FROM job_discovery_state WHERE expired = 1")
      .all() as Array<{ job_id: string }>;
    assert.equal(expired.length, 1);
    const bJob = connection(database)
      .prepare("SELECT id FROM jobs WHERE source_job_id = 'b'")
      .get() as { id: string };
    assert.equal(expired[0]?.job_id, bJob.id);
  });

  test("the grace period protects a recently-seen job and revival un-expires it", async () => {
    const database = openMemoryDatabase();
    unpause(database);
    // Grace of one hour.
    await seedTwoJobs(database, "greenhouse", 3600);
    const onlyA: RawDiscoveryOutput = {
      authoritative: true,
      postings: [{ ...samplePosting, sourceJobId: "a", url: "https://x.example.com/a" }],
    };

    // 30 minutes after first sighting: B is unseen but within grace ⇒ not expired.
    await runDiscovery(database, fakeAdapter("greenhouse", onlyA), {
      now: "2026-08-01T00:30:00.000Z",
      authoritative: true,
    });
    assert.equal(count(database, "job_discovery_state", "WHERE expired = 1"), 0);

    // Two hours after first sighting: B is now beyond grace ⇒ expired.
    await runDiscovery(database, fakeAdapter("greenhouse", onlyA), {
      now: "2026-08-01T02:00:00.000Z",
      authoritative: true,
    });
    assert.equal(count(database, "job_discovery_state", "WHERE expired = 1"), 1);

    // Re-seeing B revives it.
    await runDiscovery(
      database,
      fakeAdapter("greenhouse", {
        authoritative: true,
        postings: [
          { ...samplePosting, sourceJobId: "a", url: "https://x.example.com/a" },
          { ...samplePosting, sourceJobId: "b", url: "https://x.example.com/b" },
        ],
      }),
      { now: "2026-08-01T03:00:00.000Z", authoritative: true },
    );
    assert.equal(count(database, "job_discovery_state", "WHERE expired = 1"), 0);
  });

  test("a non-authoritative successful run does not expire jobs", async () => {
    const database = openMemoryDatabase();
    unpause(database);
    await seedTwoJobs(database, "greenhouse", 0);
    await runDiscovery(
      database,
      fakeAdapter("greenhouse", {
        authoritative: false,
        postings: [{ ...samplePosting, sourceJobId: "a", url: "https://x.example.com/a" }],
      }),
      { now: "2026-08-20T00:00:00.000Z", authoritative: false },
    );
    assert.equal(count(database, "job_discovery_state", "WHERE expired = 1"), 0);
  });

  test("an adapter that downgrades authority does not expire jobs", async () => {
    const database = openMemoryDatabase();
    unpause(database);
    await seedTwoJobs(database, "greenhouse", 0);

    // Caller requests an authoritative run, but the adapter reports it was only
    // a partial crawl. Seeing only A must NOT expire B.
    const result = await runDiscovery(
      database,
      fakeAdapter("greenhouse", {
        authoritative: false,
        postings: [{ ...samplePosting, sourceJobId: "a", url: "https://x.example.com/a" }],
      }),
      { now: "2026-08-25T00:00:00.000Z", authoritative: true },
    );
    assert.equal(result.authoritative, false);
    assert.equal(count(database, "job_discovery_state", "WHERE expired = 1"), 0);
    // The persisted run reflects the effective (downgraded) authority.
    const run = connection(database)
      .prepare("SELECT authoritative FROM discovery_runs WHERE id = ?")
      .get(result.runId) as { authoritative: 0 | 1 };
    assert.equal(run.authoritative, 0);
  });
});

describe("discovery policy and safety", () => {
  test("a disabled source prevents adapter execution", async () => {
    const database = openMemoryDatabase();
    unpause(database);
    registerSource(database, "greenhouse", { enabled: false });
    const adapter = fakeAdapter("greenhouse", { authoritative: true, postings: [samplePosting] });
    const result = await runDiscovery(database, adapter, { now: "2026-09-01T00:00:00.000Z" });
    assert.equal(adapter.calls, 0);
    assert.equal(result.status, "skipped");
    assert.equal(count(database, "discovery_runs", "WHERE status = 'skipped'"), 1);
  });

  test("global pause prevents adapter execution", async () => {
    const database = openMemoryDatabase();
    // Left paused (the seeded default is paused).
    registerSource(database, "greenhouse");
    const adapter = fakeAdapter("greenhouse", { authoritative: true, postings: [samplePosting] });
    const result = await runDiscovery(database, adapter, { now: "2026-09-02T00:00:00.000Z" });
    assert.equal(adapter.calls, 0);
    assert.equal(result.status, "skipped");
  });

  test("the kill switch prevents adapter execution", async () => {
    const database = openMemoryDatabase();
    unpause(database);
    const repository = registerSource(database, "greenhouse");
    repository.engageKillSwitch("greenhouse", true, "2026-09-03T00:00:00.000Z");
    const adapter = fakeAdapter("greenhouse", { authoritative: true, postings: [samplePosting] });
    const result = await runDiscovery(database, adapter, { now: "2026-09-03T01:00:00.000Z" });
    assert.equal(adapter.calls, 0);
    assert.equal(result.status, "skipped");
  });

  test("an unregistered source never runs", async () => {
    const database = openMemoryDatabase();
    unpause(database);
    const adapter = fakeAdapter("never-registered", { authoritative: true, postings: [samplePosting] });
    const result = await runDiscovery(database, adapter, { now: "2026-09-04T00:00:00.000Z" });
    assert.equal(adapter.calls, 0);
    assert.equal(result.status, "skipped");
  });

  test("failure details and logs do not leak sensitive response content", async () => {
    const database = openMemoryDatabase();
    unpause(database);
    registerSource(database, "greenhouse");
    const hostileBody = "SECRET-BODY-authorization-Bearer-abc123";
    await runDiscovery(
      database,
      fakeAdapter("greenhouse", () => {
        throw new Error(hostileBody);
      }),
      { now: "2026-09-05T00:00:00.000Z", authoritative: true },
    );
    const failures = connection(database)
      .prepare("SELECT category, message FROM discovery_run_failures")
      .all() as Array<{ category: string; message: string }>;
    assert.equal(failures.length, 1);
    assert.equal(failures[0]?.category, "internal");
    for (const row of failures) {
      assert.ok(!row.message.includes("SECRET"));
      assert.ok(!row.message.includes("abc123"));
      assert.ok(!row.message.includes("Bearer"));
    }
  });

  test("adapter-supplied failure messages are regenerated, never persisted verbatim", async () => {
    const database = openMemoryDatabase();
    unpause(database);
    registerSource(database, "greenhouse");
    await runDiscovery(
      database,
      fakeAdapter("greenhouse", {
        authoritative: true,
        postings: [samplePosting],
        // An adapter returning a "classified" failure could smuggle a raw body
        // into the message; the persistence layer must regenerate it.
        failures: [
          { category: "network", message: "SECRET-response-body-marker-9f9f" },
          // An out-of-vocabulary category collapses to 'internal'.
          { category: "totally-made-up" as never, message: "another-marker-body" },
        ],
      }),
      { now: "2026-09-06T00:00:00.000Z", authoritative: true },
    );
    const failures = connection(database)
      .prepare("SELECT category, message FROM discovery_run_failures ORDER BY failure_ordinal")
      .all() as Array<{ category: string; message: string }>;
    assert.equal(failures.length, 2);
    assert.equal(failures[0]?.category, "network");
    assert.equal(failures[1]?.category, "internal");
    for (const row of failures) {
      assert.ok(!row.message.includes("marker"));
      assert.ok(!row.message.includes("SECRET"));
      assert.ok(!row.message.includes("9f9f"));
    }
  });

  test("malformed adapter failure entries collapse to internal and never wedge the run", async () => {
    const database = openMemoryDatabase();
    unpause(database);
    registerSource(database, "greenhouse");
    const result = await runDiscovery(
      database,
      fakeAdapter("greenhouse", {
        authoritative: true,
        postings: [samplePosting],
        // Every one of these is junk an adapter should never emit; none may throw
        // during finalization or leave the run stuck 'running'.
        failures: [
          null,
          "a bare string",
          {},
          { category: 123 },
          { category: "totally-made-up" },
        ] as never,
      }),
      { now: "2026-09-07T00:00:00.000Z", authoritative: true },
    );
    // The run finalized (not stuck) and downgraded because failures were present.
    assert.equal(result.status, "partial");
    const run = connection(database)
      .prepare("SELECT status FROM discovery_runs WHERE id = ?")
      .get(result.runId) as { status: string };
    assert.equal(run.status, "partial");
    const rows = connection(database)
      .prepare("SELECT DISTINCT category FROM discovery_run_failures")
      .all() as Array<{ category: string }>;
    assert.deepEqual(rows, [{ category: "internal" }]);
    assert.equal(count(database, "discovery_run_failures"), 5);
  });

  test("a non-array failures value fails closed instead of being silently ignored", async () => {
    const database = openMemoryDatabase();
    unpause(database);
    registerSource(database, "greenhouse");
    const result = await runDiscovery(
      database,
      fakeAdapter("greenhouse", {
        authoritative: true,
        postings: [samplePosting],
        failures: "not-an-array" as never,
      }),
      { now: "2026-09-08T00:00:00.000Z", authoritative: true },
    );
    // The good posting still ingests, but a safe failure is recorded and the
    // run is no longer a clean authoritative success.
    assert.equal(result.status, "partial");
    assert.equal(result.authoritative, false);
    assert.equal(count(database, "jobs"), 1);
    assert.equal(count(database, "discovery_run_failures", "WHERE category = 'internal'"), 1);
  });

  for (const malformed of [
    { label: "non-array postings", value: "not-an-array" as never },
    { label: "missing postings", value: undefined },
  ]) {
    test(`malformed adapter output (${malformed.label}) fails closed and expires nothing`, async () => {
      const database = openMemoryDatabase();
      unpause(database);
      registerSource(database, "greenhouse", { graceSeconds: 0 });

      // Seed a real job with a clean authoritative run.
      await runDiscovery(
        database,
        fakeAdapter("greenhouse", { authoritative: true, postings: [samplePosting] }),
        { now: "2026-12-01T00:00:00.000Z", authoritative: true },
      );

      // The adapter now claims an authoritative crawl but returns junk postings.
      const brokenOutput = { authoritative: true } as Record<string, unknown>;
      if (malformed.value !== undefined) brokenOutput.postings = malformed.value;
      const result = await runDiscovery(
        database,
        fakeAdapter("greenhouse", brokenOutput as never),
        { now: "2026-12-05T00:00:00.000Z", authoritative: true },
      );

      // Fail closed on every axis.
      assert.notEqual(result.status, "succeeded");
      assert.equal(result.authoritative, false);
      assert.equal(count(database, "job_discovery_state", "WHERE expired = 1"), 0);
      const run = connection(database)
        .prepare("SELECT status, authoritative FROM discovery_runs WHERE id = ?")
        .get(result.runId) as { status: string; authoritative: 0 | 1 };
      assert.notEqual(run.status, "running");
      assert.notEqual(run.status, "succeeded");
      assert.equal(run.authoritative, 0);
      assert.equal(count(database, "discovery_run_failures", "WHERE category = 'schema'"), 1);
    });
  }
});

describe("discovery persistence", () => {
  test("migration 0002 applies onto a populated Phase 1 database", () => {
    const directory = mkdtempSync(join(tmpdir(), "job-agent-discovery-mig-"));
    temporaryDirectories.push(directory);
    copyFileSync(join(migrationsDir, "0001_initial.sql"), join(directory, "0001_initial.sql"));

    const sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    runMigrations(sqlite, directory);

    // Populate a Phase 1 posting (source, org, job, snapshot) using only 0001.
    sqlite
      .prepare(
        "INSERT INTO job_sources (id, source_key, display_name, created_at) VALUES ('s1','manual','Manual','2026-01-01T00:00:00.000Z')",
      )
      .run();
    sqlite
      .prepare(
        "INSERT INTO organizations (id, normalized_name, display_name, created_at) VALUES ('o1','acme','Acme','2026-01-01T00:00:00.000Z')",
      )
      .run();
    sqlite
      .prepare(
        `INSERT INTO jobs (id, source_id, source_job_id, canonical_url, organization_id, discovered_at, last_seen_at)
         VALUES ('j1','s1','req-1','https://x.example.com/1','o1','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`,
      )
      .run();
    sqlite
      .prepare(
        `INSERT INTO job_snapshots (id, job_id, content_hash, title, workplace_type, description_text, captured_at)
         VALUES ('snap1','j1','h1','Engineer','remote','Work.','2026-01-01T00:00:00.000Z')`,
      )
      .run();

    // Now apply 0002 onto the populated database.
    copyFileSync(join(migrationsDir, "0002_discovery.sql"), join(directory, "0002_discovery.sql"));
    runMigrations(sqlite, directory);

    assert.deepEqual(
      sqlite.prepare("SELECT version FROM schema_migrations ORDER BY version").all(),
      [{ version: 1 }, { version: 2 }],
    );
    // New table exists, Phase 1 data intact, relational graph consistent.
    assert.equal(
      (sqlite.prepare("SELECT COUNT(*) AS c FROM discovery_runs").get() as { c: number }).c,
      0,
    );
    assert.equal(
      (sqlite.prepare("SELECT title FROM job_snapshots WHERE id = 'snap1'").get() as { title: string })
        .title,
      "Engineer",
    );
    assert.deepEqual(sqlite.pragma("foreign_key_check"), []);
    sqlite.close();
  });

  test("posting snapshots are immutable after 0002", async () => {
    const database = openMemoryDatabase();
    unpause(database);
    registerSource(database, "greenhouse");
    await runDiscovery(
      database,
      fakeAdapter("greenhouse", { authoritative: true, postings: [samplePosting] }),
      { now: "2026-10-01T00:00:00.000Z", authoritative: true },
    );
    assert.throws(
      () => connection(database).prepare("UPDATE job_snapshots SET title = 'x'").run(),
      /job_snapshots are immutable evidence/,
    );
    assert.throws(
      () => connection(database).prepare("DELETE FROM job_snapshots").run(),
      /job_snapshots are immutable evidence/,
    );
  });

  test("re-registering a source preserves user enable/disable and grace settings", async () => {
    const database = openMemoryDatabase();
    const repository = new DiscoveryRepository(database);

    // A brand-new source registers DISABLED by default (safe startup).
    repository.registerSource({
      sourceKey: "greenhouse",
      displayName: "Greenhouse",
      capabilities: discoveryOnly,
      now: "2026-01-01T00:00:00.000Z",
    });
    assert.equal(repository.getSourceHealth("greenhouse")?.enabled, false);

    // The user enables it and sets a grace period.
    repository.setSourceEnabled("greenhouse", true, "2026-01-02T00:00:00.000Z");
    connection(database)
      .prepare("UPDATE source_discovery_settings SET expiration_grace_seconds = 7200 WHERE 1")
      .run();

    // Re-registering (e.g. on the next startup) WITHOUT enabled/grace must not
    // flip the user's choices back.
    repository.registerSource({
      sourceKey: "greenhouse",
      displayName: "Greenhouse",
      capabilities: discoveryOnly,
      now: "2026-01-03T00:00:00.000Z",
    });
    assert.equal(repository.getSourceHealth("greenhouse")?.enabled, true);
    const grace = connection(database)
      .prepare("SELECT expiration_grace_seconds AS g FROM source_discovery_settings")
      .get() as { g: number };
    assert.equal(grace.g, 7200);

    // The user disables it; re-registration must keep it disabled.
    repository.setSourceEnabled("greenhouse", false, "2026-01-04T00:00:00.000Z");
    repository.registerSource({
      sourceKey: "greenhouse",
      displayName: "Greenhouse",
      capabilities: discoveryOnly,
      now: "2026-01-05T00:00:00.000Z",
    });
    assert.equal(repository.getSourceHealth("greenhouse")?.enabled, false);
  });

  test("a finalized run rejects further ingestion, re-finalization, and edits", async () => {
    const database = openMemoryDatabase();
    unpause(database);
    const repository = registerSource(database, "greenhouse");
    const result = await runDiscovery(
      database,
      fakeAdapter("greenhouse", { authoritative: true, postings: [samplePosting] }),
      { now: "2026-10-05T00:00:00.000Z", authoritative: true },
    );

    const normalized = {
      sourceJobId: "req-late",
      canonicalUrl: "https://x.example.com/late",
      title: "Engineer",
      company: "Acme",
      locationText: null,
      workplaceType: "remote" as const,
      employmentType: null,
      descriptionText: "Work.",
      postedAt: null,
      closesAt: null,
      contentHash: "late-hash",
      fingerprint: "late-fp",
    };
    const before = {
      observations: count(database, "posting_observations"),
      jobs: count(database, "jobs"),
    };
    assert.throws(
      () => repository.ingestPosting(result.runId, normalized, "2026-10-05T01:00:00.000Z"),
      /is not running/,
    );
    assert.throws(
      () =>
        repository.finishRun({
          runId: result.runId,
          status: "succeeded",
          authoritative: true,
          postingsSeen: 0,
          newJobs: 0,
          newSnapshots: 0,
          failures: [],
          now: "2026-10-05T02:00:00.000Z",
        }),
      /already finalized/,
    );
    // Even a raw UPDATE cannot rewrite a terminal run's history.
    assert.throws(
      () =>
        connection(database)
          .prepare("UPDATE discovery_runs SET postings_seen = 999 WHERE id = ?")
          .run(result.runId),
      /finalized discovery_run cannot be modified/,
    );
    assert.deepEqual(
      {
        observations: count(database, "posting_observations"),
        jobs: count(database, "jobs"),
      },
      before,
    );
  });

  test("restart preserves discovery state and run history", async () => {
    const directory = mkdtempSync(join(tmpdir(), "job-agent-discovery-restart-"));
    temporaryDirectories.push(directory);
    const filename = join(directory, "agent.sqlite");

    const first = openDatabase({ filename });
    unpause(first);
    registerSource(first, "greenhouse", { graceSeconds: 0, now: "2026-11-01T00:00:00.000Z" });
    const result = await runDiscovery(
      first,
      fakeAdapter("greenhouse", { authoritative: true, postings: [samplePosting] }),
      { now: "2026-11-01T00:00:00.000Z", authoritative: true },
    );
    first.close();

    const second = openDatabase({ filename });
    openDatabases.push(second);
    const repository = new DiscoveryRepository(second);
    const runs = repository.listRuns({ sourceKey: "greenhouse" });
    assert.equal(runs.length, 1);
    assert.equal(runs[0]?.id, result.runId);
    assert.equal(runs[0]?.status, "succeeded");

    const health = repository.getSourceHealth("greenhouse");
    assert.equal(health?.lastStatus, "succeeded");
    assert.equal(health?.consecutiveFailures, 0);

    assert.equal(count(second, "jobs"), 1);
    assert.equal(count(second, "posting_observations"), 1);
    assert.equal(count(second, "job_discovery_state"), 1);
  });
});
