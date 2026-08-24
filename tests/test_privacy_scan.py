import subprocess
import sys
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

sys.path.insert(0, str(REPO_ROOT / "tools"))
import privacy_scan  # noqa: E402


class DetectionTests(unittest.TestCase):
    """Exercises the scanner's text detectors and allowlists directly."""

    def setUp(self):
        privacy_scan.errors.clear()

    def scan(self, text: str) -> list[str]:
        privacy_scan.errors.clear()
        privacy_scan.scan_text("fixture.ts", text)
        return list(privacy_scan.errors)

    def test_flags_a_real_looking_email(self):
        findings = self.scan('const to = "recruiter@acme-corp.com";')
        self.assertEqual(len(findings), 1)
        self.assertIn("email", findings[0])

    def test_allows_reserved_synthetic_email_domains(self):
        for address in ("alice@example.com", "x@example.invalid", "y@sub.example.org"):
            self.assertEqual(self.scan(f'const e = "{address}";'), [], address)

    def test_flags_a_real_looking_phone_number(self):
        findings = self.scan('const p = "212-987-6543";')
        self.assertEqual(len(findings), 1)
        self.assertIn("phone", findings[0])
        # A fictional 555-01xx number on its own line produces no finding.
        self.assertEqual(self.scan('const p = "212-555-0134";'), [])

    def test_allows_reserved_fictional_555_numbers(self):
        self.assertEqual(self.scan('phone "+1 555 010 0"'), [])
        self.assertEqual(self.scan('phone "(415) 555-0100"'), [])

    def test_flags_common_secret_shapes(self):
        for secret, label in [
            ("sk-abcdefghijklmnopqrstuvwx", "OpenAI"),
            ("ghp_abcdefghijklmnopqrstuvwxyz0123456789", "GitHub"),
            ("AKIAIOSFODNN7EXAMPLE", "AWS"),
        ]:
            findings = self.scan(f'const k = "{secret}";')
            self.assertTrue(findings, f"expected a finding for {label}")

    def test_allows_approved_synthetic_secret_values(self):
        for value in sorted(privacy_scan.ALLOWED_SECRET_VALUES):
            self.assertEqual(self.scan(f'token: "{value}",'), [], value)

    def test_allows_redaction_placeholders(self):
        self.assertEqual(self.scan('secret = "[redacted:token]"'), [])


class OutputSafetyTests(unittest.TestCase):
    """A finding must never re-publish the private value it detected.

    This guard runs in CI; echoing the matched email/phone/token (or the source
    line) into the Actions log would leak exactly the data it exists to catch.
    """

    def setUp(self):
        privacy_scan.errors.clear()

    def test_findings_never_echo_the_detected_value_or_source_line(self):
        email = "recruiter@acme-corp.com"
        phone = "212-987-6543"
        token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789"
        source = f'const c = {{ email: "{email}", phone: "{phone}", token: "{token}" }};'
        privacy_scan.errors.clear()
        privacy_scan.scan_text("fixture.ts", source)

        self.assertTrue(privacy_scan.errors, "the fixture must trigger findings")
        joined = "\n".join(privacy_scan.errors)
        for secret in (email, phone, token, "acme-corp", source):
            self.assertNotIn(secret, joined, f"finding output leaked {secret!r}")
        # Findings still carry the actionable location and category.
        self.assertTrue(all("fixture.ts:1:" in e for e in privacy_scan.errors))


class ScopeTests(unittest.TestCase):
    def test_candidate_profile_paths_are_excluded(self):
        for name in ("CLAUDE.md", "cv", "cover_letters", "documents", "job_search_tracker.csv"):
            self.assertIn(name, privacy_scan.EXCLUDED_PERSONAL_PATHS)

    def test_excluded_personal_path_is_never_read(self):
        self.assertTrue(privacy_scan._is_excluded_personal(REPO_ROOT / "CLAUDE.md"))
        self.assertTrue(privacy_scan._is_excluded_personal(REPO_ROOT / "cv" / "main_example.tex"))
        self.assertFalse(
            privacy_scan._is_excluded_personal(REPO_ROOT / "apps" / "desktop" / "src" / "main" / "main.ts")
        )


class EndToEndTests(unittest.TestCase):
    def test_scanner_passes_on_the_real_product_tree(self):
        result = subprocess.run(
            [sys.executable, str(REPO_ROOT / "tools" / "privacy_scan.py")],
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("privacy_scan: OK", result.stdout)


if __name__ == "__main__":
    unittest.main()
