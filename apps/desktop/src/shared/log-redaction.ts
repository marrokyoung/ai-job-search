/**
 * Structured logging with mandatory redaction of sensitive values.
 *
 * Phase 1 stores only synthetic data and makes no network requests, but the
 * shell must never emit a private value into a log line even by accident: a
 * future extractor, submitter, or email connector will handle real contact
 * details, credentials, application answers, and message bodies. This module
 * is the single choke point every log record passes through, so that guarantee
 * holds structurally rather than by remembering to scrub at each call site.
 *
 * Redaction happens two ways, both applied:
 *
 * 1. By field classification — a key whose name matches one of the four
 *    sensitive classes (contact, token, answer, message-content) has its whole
 *    value replaced with `[redacted:<class>]`, regardless of the value's shape.
 * 2. By value pattern — inside any string that is NOT wholly redacted by (1)
 *    (including free-form text and unclassified fields), embedded emails, phone
 *    numbers, and token-like secrets are masked in place. This catches a
 *    contact detail that leaks through a generically named field.
 *
 * Redaction is applied recursively to arrays and nested objects and is
 * depth-bounded so a cyclic or pathological record can never hang the logger.
 */

export type SensitiveClass = "contact" | "token" | "answer" | "message";

export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * Classifies a field by its key name. Ordering matters: `token` is checked
 * before `contact` so a key like `contactToken` is treated as a secret, and
 * `answer`/`message` are checked before the broad `contact` address matchers.
 * Matching is case-insensitive and ignores separators, so `apiKey`,
 * `api_key`, and `API-KEY` all classify identically.
 */
export function classifyField(key: string): SensitiveClass | null {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");

  // Tokens / credentials first — the most damaging to leak.
  if (
    /(^|_)?(token|secret|password|passwd|apikey|accesskey|privatekey|credential|authorization|auth|bearer|cookie|sessionid|refreshtoken|clientsecret)($|[0-9])/.test(
      normalized,
    ) ||
    normalized.includes("token") ||
    normalized.includes("secret") ||
    normalized.includes("password") ||
    normalized.includes("apikey") ||
    normalized.includes("credential") ||
    normalized === "authorization" ||
    normalized.includes("bearer")
  ) {
    return "token";
  }

  // Application answers (free-text responses to screening questions).
  if (
    normalized === "answer" ||
    normalized === "answers" ||
    normalized.includes("answertext") ||
    normalized.includes("fieldanswer") ||
    normalized.includes("applicationanswer") ||
    normalized.includes("screeninganswer") ||
    normalized.includes("responsetext")
  ) {
    return "answer";
  }

  // Message / free-form content bodies.
  if (
    normalized === "message" ||
    normalized === "body" ||
    normalized === "content" ||
    normalized.includes("messagebody") ||
    normalized.includes("messagecontent") ||
    normalized.includes("emailbody") ||
    normalized.includes("coverletter") ||
    normalized.includes("notetext")
  ) {
    return "message";
  }

  // Contact details.
  if (
    normalized === "email" ||
    normalized.includes("emailaddress") ||
    normalized === "phone" ||
    normalized.includes("phonenumber") ||
    normalized === "mobile" ||
    normalized === "contact" ||
    normalized.includes("contactemail") ||
    normalized.includes("contactphone") ||
    normalized === "address" ||
    normalized.includes("streetaddress")
  ) {
    return "contact";
  }

  return null;
}

// Deliberately conservative patterns: they mask obvious PII/secret shapes
// without trying to be a universal detector. Over-masking a log line is
// acceptable; leaking a real value is not.
const EMAIL_PATTERN = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
// International and US-style phone numbers: an optional +, then 9+ digits with
// spaces, dots, or dashes. Requires enough digits to avoid masking ordinary
// small integers.
const PHONE_PATTERN = /\+?\d[\d\s().-]{8,}\d/g;
// Bearer tokens and long opaque secrets (JWT-ish / hex / base64 runs of 20+).
const BEARER_PATTERN = /\b[Bb]earer\s+[A-Za-z0-9._-]+/g;
const LONG_TOKEN_PATTERN = /\b[A-Za-z0-9._-]{24,}\b/g;

/** Masks embedded emails, phone numbers, and token-like runs inside a string. */
export function maskEmbeddedSecrets(value: string): string {
  return value
    .replace(EMAIL_PATTERN, "[redacted:contact]")
    .replace(BEARER_PATTERN, "[redacted:token]")
    .replace(PHONE_PATTERN, "[redacted:contact]")
    .replace(LONG_TOKEN_PATTERN, "[redacted:token]");
}

const MAX_DEPTH = 8;

/**
 * Returns a redacted deep copy of `value`. Classified fields are replaced
 * wholesale; every surviving string is passed through embedded-secret masking.
 * The input is never mutated.
 */
export function redactLogValue(value: unknown): unknown {
  return redactInternal(value, MAX_DEPTH, new WeakSet());
}

function redactInternal(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
): unknown {
  if (typeof value === "string") return maskEmbeddedSecrets(value);
  if (value === null || typeof value !== "object") return value;
  if (depth <= 0) return "[redacted:depth]";
  if (seen.has(value)) return "[redacted:circular]";
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redactInternal(item, depth - 1, seen));
  }

  const output: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    const sensitivity = classifyField(key);
    if (sensitivity !== null) {
      output[key] = `[redacted:${sensitivity}]`;
      continue;
    }
    output[key] = redactInternal(nested, depth - 1, seen);
  }
  return output;
}

export type LogRecord = {
  level: LogLevel;
  message: string;
  time: string;
  [field: string]: unknown;
};

/**
 * Builds a single structured, fully-redacted log record. The human-readable
 * `message` is masked for embedded secrets too, and any structured `fields`
 * are redacted by class and pattern. `time` must be supplied by the caller so
 * this stays deterministic and testable.
 */
export function buildLogRecord(input: {
  level: LogLevel;
  message: string;
  time: string;
  fields?: Record<string, unknown>;
}): LogRecord {
  const redactedFields = input.fields
    ? (redactLogValue(input.fields) as Record<string, unknown>)
    : {};
  return {
    ...redactedFields,
    level: input.level,
    message: maskEmbeddedSecrets(input.message),
    time: input.time,
  };
}

export type StructuredLogger = {
  log(
    level: LogLevel,
    message: string,
    fields?: Record<string, unknown>,
  ): void;
};

/**
 * A structured logger that emits one redacted JSON object per line to `sink`
 * (defaults to `console.log`). Every value crossing it is redacted first, so no
 * call site can bypass the guarantee.
 */
export function createStructuredLogger(options?: {
  sink?: (line: string) => void;
  now?: () => string;
}): StructuredLogger {
  const sink = options?.sink ?? ((line: string) => console.log(line));
  const now = options?.now ?? (() => new Date().toISOString());
  return {
    log(level, message, fields) {
      sink(
        JSON.stringify(
          buildLogRecord({ level, message, time: now(), ...(fields ? { fields } : {}) }),
        ),
      );
    },
  };
}
