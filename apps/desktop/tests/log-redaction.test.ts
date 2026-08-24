import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  buildLogRecord,
  classifyField,
  createStructuredLogger,
  maskEmbeddedSecrets,
  redactLogValue,
} from "../src/shared/log-redaction.ts";

// All literals below are synthetic: reserved example.com addresses and 555
// phone numbers, plus obviously-fake tokens. They exist to prove redaction
// works; the repository privacy scan allowlists this test file for exactly
// that reason.

describe("field classification", () => {
  test("classifies contact fields", () => {
    for (const key of ["email", "emailAddress", "phone", "phoneNumber", "mobile", "contact", "address"]) {
      assert.equal(classifyField(key), "contact", `expected ${key} => contact`);
    }
  });

  test("classifies token fields regardless of separators or case", () => {
    for (const key of ["token", "accessToken", "refreshToken", "apiKey", "api_key", "API-KEY", "secret", "clientSecret", "password", "authorization", "credential"]) {
      assert.equal(classifyField(key), "token", `expected ${key} => token`);
    }
  });

  test("classifies answer fields", () => {
    for (const key of ["answer", "answers", "screeningAnswer", "applicationAnswer", "responseText"]) {
      assert.equal(classifyField(key), "answer", `expected ${key} => answer`);
    }
  });

  test("classifies message-content fields", () => {
    for (const key of ["message", "body", "content", "messageBody", "emailBody", "coverLetter"]) {
      assert.equal(classifyField(key), "message", `expected ${key} => message`);
    }
  });

  test("leaves ordinary fields unclassified", () => {
    for (const key of ["jobId", "state", "count", "createdAt", "level", "durationMs"]) {
      assert.equal(classifyField(key), null, `expected ${key} => null`);
    }
  });

  test("a token-named field wins over its contact-like substring", () => {
    // contactToken must be a secret, not a contact detail.
    assert.equal(classifyField("contactToken"), "token");
  });
});

describe("field-level redaction", () => {
  test("replaces each sensitive class with its labeled placeholder", () => {
    const redacted = redactLogValue({
      jobId: "job-123",
      email: "alice@example.com",
      phone: "+1 555 0100",
      apiKey: "sk-not-a-real-key-000000000000",
      answer: "I have five years of experience.",
      message: "Dear hiring manager, please find attached...",
    }) as Record<string, string>;

    assert.equal(redacted.jobId, "job-123");
    assert.equal(redacted.email, "[redacted:contact]");
    assert.equal(redacted.phone, "[redacted:contact]");
    assert.equal(redacted.apiKey, "[redacted:token]");
    assert.equal(redacted.answer, "[redacted:answer]");
    assert.equal(redacted.message, "[redacted:message]");
  });

  test("redacts nested objects and arrays", () => {
    const redacted = redactLogValue({
      applicant: { details: { email: "bob@example.com" } },
      events: [{ note: "ok" }, { password: "hunter2placeholder" }],
    }) as {
      applicant: { details: { email: string } };
      events: Array<Record<string, string>>;
    };
    // A classified key nested deep is still redacted...
    assert.equal(redacted.applicant.details.email, "[redacted:contact]");
    assert.equal(redacted.events[1]?.password, "[redacted:token]");
    // ...and an unclassified sibling value is preserved.
    assert.equal(redacted.events[0]?.note, "ok");
  });

  test("redacts a whole subtree whose key is itself sensitive", () => {
    const redacted = redactLogValue({
      contact: { email: "bob@example.com", phone: "+1 555 0100" },
    }) as Record<string, unknown>;
    assert.equal(redacted.contact, "[redacted:contact]");
  });

  test("does not mutate the input", () => {
    const input = { email: "carol@example.com" };
    redactLogValue(input);
    assert.equal(input.email, "carol@example.com");
  });

  test("bounds recursion depth and survives cycles", () => {
    const cyclic: Record<string, unknown> = { level: 1 };
    cyclic.self = cyclic;
    const redacted = redactLogValue(cyclic) as Record<string, unknown>;
    assert.equal(redacted.self, "[redacted:circular]");
  });
});

describe("value-pattern masking", () => {
  test("masks an email embedded in an unclassified free-text field", () => {
    const redacted = redactLogValue({
      summary: "Reach the candidate at dave@example.com about the role.",
    }) as Record<string, string>;
    const summary = redacted.summary ?? "";
    assert.equal(summary.includes("dave@example.com"), false);
    assert.match(summary, /\[redacted:contact\]/);
  });

  test("masks phone numbers and bearer tokens embedded in text", () => {
    assert.equal(
      maskEmbeddedSecrets("call +1 555 0199 now").includes("555 0199"),
      false,
    );
    assert.equal(
      maskEmbeddedSecrets("Authorization: Bearer abc.def.ghi123").includes("abc.def.ghi123"),
      false,
    );
  });

  test("leaves short ordinary strings and numbers untouched", () => {
    assert.equal(maskEmbeddedSecrets("shortlisted"), "shortlisted");
    assert.equal(maskEmbeddedSecrets("state=eligible"), "state=eligible");
  });
});

describe("structured log records", () => {
  test("buildLogRecord masks the message and stamps the supplied time", () => {
    const record = buildLogRecord({
      level: "error",
      message: "failed to email erin@example.com",
      time: "2026-01-01T00:00:00.000Z",
      fields: { jobId: "job-9", token: "secret-value-placeholder-0000" },
    });
    assert.equal(record.level, "error");
    assert.equal(record.time, "2026-01-01T00:00:00.000Z");
    assert.equal(record.message.includes("erin@example.com"), false);
    assert.equal(record.jobId, "job-9");
    assert.equal(record.token, "[redacted:token]");
  });

  test("createStructuredLogger emits one redacted JSON line per call", () => {
    const lines: string[] = [];
    const logger = createStructuredLogger({
      sink: (line) => lines.push(line),
      now: () => "2026-02-02T00:00:00.000Z",
    });
    logger.log("info", "settings updated", { email: "frank@example.com", paused: true });
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0] as string) as Record<string, unknown>;
    assert.equal(parsed.level, "info");
    assert.equal(parsed.email, "[redacted:contact]");
    assert.equal(parsed.paused, true);
    assert.equal(JSON.stringify(parsed).includes("frank@example.com"), false);
  });
});
