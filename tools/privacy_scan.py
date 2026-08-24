#!/usr/bin/env python3
"""Privacy scanner for the US Job Agent desktop product and its packaged output.

Run from anywhere: python tools/privacy_scan.py
Add --include-dist to also scan a built apps/desktop/dist/ (it is scanned
automatically when present).

Phase 1 stores only synthetic data and makes no network requests, but this
guard makes that structural: it fails if a real-looking email address, phone
number, or credential/token appears anywhere in the desktop product source,
its tests, the SQL migrations, synthetic fixtures, or the packaged build
output (dist/, the exact bytes that go into app.asar).

Scope is deliberately the DESKTOP PRODUCT only (apps/desktop and packages/).
The personalized job-application workspace — CLAUDE.md, cv/, cover_letters/,
documents/, the tracker, and so on — holds the user's real candidate profile
by design. This scanner never reads those files: they are both out of the scan
roots AND listed in EXCLUDED_PERSONAL_PATHS so that pointing the scanner at the
repository root can never read, expose, or modify the candidate profile.

Approved synthetic values pass through explicit, narrow allowlists:
reserved documentation domains (example.com/.org/.net, *.invalid), reserved
"555-01xx" fictional phone numbers, and the labeled redaction placeholders the
logger emits. Anything else that matches a PII/secret shape is a failure.

Stdlib only. Exit 0 on success, 1 with a failure list otherwise.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Desktop-product scan roots (relative to the repo root). Only these trees are
# read; the candidate-profile workspace is intentionally not among them.
SCAN_ROOTS = [
    "apps/desktop/src",
    "apps/desktop/tests",
    "apps/desktop/build.mjs",
    "apps/desktop/electron-builder.yml",
    "apps/desktop/package.json",
    "packages",
]

# Personalized workspace paths that must never be read by this scanner, even if
# a future edit widens SCAN_ROOTS or someone runs it against the repo root.
# These hold the user's real candidate profile and are handled by .gitignore
# and the job-application workflow, not by this product guard.
EXCLUDED_PERSONAL_PATHS = {
    "CLAUDE.md",
    "cv",
    "cover_letters",
    "documents",
    "upskill",
    "gmail_sync",
    "reports",
    "job_scraper",
    "job_search_tracker.csv",
    "salary_data.json",
}

# Directories that never contain product source worth scanning.
EXCLUDED_DIR_NAMES = {
    "node_modules",
    ".git",
    "__pycache__",
    ".venv",
    "release",  # packaging output (installer + unpacked electron runtime)
    "native",   # dist/native holds the compiled better_sqlite3.node (binary)
}

TEXT_SUFFIXES = {
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
    ".json",
    ".sql",
    ".css",
    ".html",
    ".yml",
    ".yaml",
    ".md",
    ".txt",
}

# --- Allowlists for approved synthetic values -----------------------------

# Reserved documentation/test domains (RFC 2606 / RFC 6761). Emails at these
# domains are synthetic by definition.
ALLOWED_EMAIL_DOMAINS = (
    "example.com",
    "example.org",
    "example.net",
    "example.edu",
    "example.invalid",
    "test.invalid",
    "localhost",
)

# The labeled placeholders the redaction logger substitutes. They contain no
# real data but must not themselves trip the token/e-mail heuristics.
ALLOWED_LITERALS = {
    "[redacted:contact]",
    "[redacted:token]",
    "[redacted:answer]",
    "[redacted:message]",
    "[redacted:circular]",
    "[redacted:depth]",
}

# Approved synthetic secret literals. These exist ONLY in the redaction tests,
# where a value must look credential-shaped to prove the logger scrubs it. Each
# is self-evidently fake; add a new one here (in the same reviewed diff) if a
# test needs another synthetic secret.
ALLOWED_SECRET_VALUES = {
    "sk-not-a-real-key-000000000000",
    "hunter2placeholder",
    "secret-value-placeholder-0000",
}

EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")

# US/E.164-style phone numbers. Reserved 555-01xx fictional numbers are
# allowlisted separately below.
PHONE_RE = re.compile(
    r"(?<!\d)(?:\+?1[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]\d{3}[\s.-]\d{4}(?!\d)"
    r"|(?<!\d)\+\d{10,15}(?!\d)"
)

# Concrete credential/token shapes. Generic enough to catch a pasted secret,
# narrow enough not to fire on ordinary identifiers.
SECRET_RES = [
    ("private key block", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
    ("AWS access key id", re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b")),
    ("GitHub token", re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}\b")),
    ("OpenAI-style key", re.compile(r"\bsk-[A-Za-z0-9]{20,}\b")),
    ("Slack token", re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}\b")),
    ("JWT", re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}")),
    (
        "assigned secret literal",
        re.compile(
            r"(?i)(?:api[_-]?key|secret|password|passwd|token|credential)"
            r"\s*[:=]\s*['\"][^'\"\s]{8,}['\"]"
        ),
    ),
]

errors: list[str] = []


def _is_allowed_email(match: str) -> bool:
    domain = match.split("@", 1)[1].lower()
    return any(domain == d or domain.endswith("." + d) for d in ALLOWED_EMAIL_DOMAINS)


def _is_allowed_phone(match: str) -> bool:
    digits = re.sub(r"\D", "", match)
    # US fictional range: NPA-555-01XX (after optional country code 1).
    national = digits[1:] if len(digits) == 11 and digits.startswith("1") else digits
    if len(national) == 10 and national[3:6] == "555" and national[6:8] == "01":
        return True
    return False


def _line_number(text: str, index: int) -> int:
    return text.count("\n", 0, index) + 1


def _line_snippet(text: str, index: int) -> str:
    """The source line at `index` — used ONLY for allowlist decisions, never
    emitted into a finding (see the module docstring / scan_text)."""
    start = text.rfind("\n", 0, index) + 1
    end = text.find("\n", index)
    if end == -1:
        end = len(text)
    return text[start:end].strip()


def _secret_is_allowed(snippet: str) -> bool:
    return any(literal in snippet for literal in ALLOWED_LITERALS) or any(
        value in snippet for value in ALLOWED_SECRET_VALUES
    )


# CRITICAL: a finding must report only WHERE and WHAT CATEGORY, never the matched
# value or the surrounding source line. This guard runs in CI, and echoing the
# detected email/phone/token back into the Actions log would re-publish exactly
# the private data it exists to keep out. Callers get file:line + category +
# remediation and must open the file locally to see the value.
def scan_text(relpath: str, text: str) -> None:
    for match in EMAIL_RE.finditer(text):
        if _is_allowed_email(match.group(0)):
            continue
        line_no = _line_number(text, match.start())
        errors.append(
            f"{relpath}:{line_no}: [contact] possible real email address. "
            f"Use a reserved synthetic domain "
            f"({', '.join(ALLOWED_EMAIL_DOMAINS[:3])}, *.invalid) or add a narrow "
            "allowlist entry in tools/privacy_scan.py."
        )
    for match in PHONE_RE.finditer(text):
        if _is_allowed_phone(match.group(0)):
            continue
        line_no = _line_number(text, match.start())
        errors.append(
            f"{relpath}:{line_no}: [contact] possible real phone number. "
            "Use a reserved 555-01xx fictional number."
        )
    for label, pattern in SECRET_RES:
        for match in pattern.finditer(text):
            if _secret_is_allowed(_line_snippet(text, match.start())):
                continue
            line_no = _line_number(text, match.start())
            errors.append(
                f"{relpath}:{line_no}: [{label}] possible secret/credential. "
                "Remove it; secrets must never appear in the product tree."
            )


def _iter_files(base: Path):
    if base.is_file():
        yield base
        return
    for path in sorted(base.rglob("*")):
        if not path.is_file():
            continue
        if any(part in EXCLUDED_DIR_NAMES for part in path.relative_to(ROOT).parts):
            continue
        yield path


def _is_excluded_personal(path: Path) -> bool:
    try:
        parts = path.relative_to(ROOT).parts
    except ValueError:
        return False
    return bool(parts) and parts[0] in EXCLUDED_PERSONAL_PATHS


def collect_targets() -> list[Path]:
    targets: list[Path] = []
    roots = list(SCAN_ROOTS)
    dist = ROOT / "apps/desktop/dist"
    if ("--include-dist" in sys.argv or dist.exists()) and "apps/desktop/dist" not in roots:
        roots.append("apps/desktop/dist")
    for root in roots:
        base = ROOT / root
        if not base.exists():
            continue
        for path in _iter_files(base):
            if _is_excluded_personal(path):
                continue
            if path.suffix.lower() not in TEXT_SUFFIXES:
                continue
            targets.append(path)
    return targets


def main() -> int:
    targets = collect_targets()
    if not targets:
        print("privacy_scan: no product files found - scan roots are wrong or the tree moved")
        return 1
    for path in targets:
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            # Non-UTF8/binary content is not product source we can meaningfully
            # scan for pasted PII; skip it rather than guess.
            continue
        scan_text(str(path.relative_to(ROOT)).replace("\\", "/"), text)

    if errors:
        print(f"privacy_scan: {len(errors)} finding(s)")
        for err in errors:
            print(f"  - {err}")
        return 1
    print(f"privacy_scan: OK ({len(targets)} files scanned, no real PII or secrets found)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
