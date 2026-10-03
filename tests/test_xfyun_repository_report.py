"""Offline unit fixtures only: no real dispatch, provider, or new pass evidence.

Run: python -m unittest discover -s tests -p test_xfyun_repository_report.py
The fixture schema follows actions-bridge._snapshot / the Python repair report;
these fabricated unit data are NOT authenticated production tool responses.
"""
import copy
import hashlib
import importlib.util
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1] / "scripts" / "xfyun-repository-report.py"
SPEC = importlib.util.spec_from_file_location("xfyun_repository_report", SOURCE)
GATE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(GATE)

NOW = datetime(2026, 10, 3, 12, 0, tzinfo=timezone.utc)
REQUEST = "2026-10-03T11:59:00Z"
REPO = "https://github.com/wenjieding327/repo-rescue-canary"
JOB = "J" * 43
PATCH = "--- a/src/parser.py\n+++ b/src/parser.py\n@@ -1 +1 @@\n-return ''\n+return 'untitled'\n"
RECEIPT = "https://reporescue-mcp-production.up.railway.app/r/v1.123.456.1791075600." + "S" * 32


def digest(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def execution(exit_code, stdout, counts=None):
    value = {"exit_code": exit_code, "timed_out": False, "duration_seconds": 0.3, "stdout": stdout, "stderr": ""}
    if counts is not None:
        value["pytest_attestation"] = counts
    return value


def phase(verified):
    counts = {"completed": True, "collected": 3, "passed": 3 if verified else 2, "failed": 0 if verified else 1, "skipped": 0, "errors": 0, "runner_exit_code": 0 if verified else 1}
    value = {"status": "verified" if verified else "verification_failed", "verified": verified, "backend": "docker", "command": "python -m pytest -q", "verification_scope": "pytest_suite", "repair_evidence_eligible": True, "install": execution(0, ""), "execution": execution(0 if verified else 1, "3 passed\n" if verified else "1 failed, 2 passed\n", counts)}
    if not verified:
        value["preparation_baseline_sha256"] = "b" * 64
    return value


def success():
    repair = {"schema_version": "1.0", "run_id": "unit_fixture_only", "status": "verified_repair", "verified_repair": True, "started_at": "2026-10-03T11:59:10Z", "completed_at": "2026-10-03T11:59:20Z", "repository": {"slug": "wenjieding327/repo-rescue-canary", "url": REPO, "commit": "c" * 40}, "verifier_backend": "docker", "baseline": phase(False), "final_verification": phase(True), "changed_files": ["src/parser.py"], "patch_sha256": digest(PATCH)}
    identity = "|".join((repair["run_id"], repair["repository"]["commit"], "python -m pytest -q", "1", "0", repair["patch_sha256"]))
    repair["attestation_sha256"] = digest(identity)
    contents = {"patch": PATCH, "evidence": json.dumps(repair), "report": "# Unit fixture\n" + repair["run_id"]}
    files = {name: {"bytes": len(contents[field].encode("utf-8")), "sha256": digest(contents[field])} for field, name in (("patch", "repair.patch"), ("evidence", "evidence.json"), ("report", "report.md"))}
    actions = {"repository": GATE.BRIDGE_REPOSITORY, "workflow_run_id": 123, "artifact_id": 456, "head_sha": "a" * 40, "artifact_name": "repo-rescue-" + "R" * 43, "artifact_digest": "sha256:" + "d" * 64, "artifact_contents": contents, "files": files}
    return {"ok": True, "job": {"job_id": JOB, "operation": "verify_github_patch", "status": "succeeded", "terminal": True, "poll_tool": "get_repair_job", "result": {"ok": True, "repair": repair, "github_actions": actions}}}


def envelope(payload, receipt="", is_error=False):
    return json.dumps({"isError": is_error, "content": [{"type": "text", "text": json.dumps(payload)}], "receipt_url": receipt})


def render(payload, receipt="", job=JOB, repo=REPO, request=REQUEST):
    with patch.object(GATE, "_now", return_value=NOW):
        return GATE.main(envelope(payload, receipt), repo, job, request)


def sync_artifact(payload):
    result = payload["job"]["result"]
    text = json.dumps(result["repair"])
    result["github_actions"]["artifact_contents"]["evidence"] = text
    result["github_actions"]["files"]["evidence.json"] = {"bytes": len(text.encode("utf-8")), "sha256": digest(text)}


class RepositoryReportTests(unittest.TestCase):
    def assertNotVerified(self, result, status=None):
        self.assertNotEqual(result["status"], "verified_repair")
        self.assertNotIn("verified_repair=true", result["report"])
        self.assertNotIn(JOB, result["report"])
        if status:
            self.assertEqual(result["status"], status)

    def test_complete_current_artifact_and_issued_receipt(self):
        result = render(success(), RECEIPT)
        self.assertEqual(set(result), {"report", "status"})
        self.assertEqual(result["status"], "verified_repair")
        self.assertIn(RECEIPT, result["report"])
        self.assertIn(REPO, result["report"])
        self.assertIn('stdout="1 failed, 2 passed\\n"', result["report"])
        self.assertIn('stdout="3 passed\\n"', result["report"])
        self.assertNotIn(JOB, result["report"])
        self.assertNotIn("R" * 43, result["report"])

    def test_absent_receipt_does_not_invent_delivery(self):
        result = render(success())
        self.assertEqual(result["status"], "verified_repair")
        self.assertIn("不拼接或伪造链接", result["report"])
        self.assertNotIn("/r/v1", result["report"])

    def test_actual_wire_operation_not_invented_kind_or_job_timestamps(self):
        payload = success()
        self.assertNotIn("kind", payload["job"])
        self.assertNotIn("created_at", payload["job"])
        self.assertEqual(render(payload)["status"], "verified_repair")
        payload["job"]["kind"] = "verify"
        del payload["job"]["operation"]
        self.assertNotVerified(render(payload), "invalid_evidence")

    def test_direct_envelope_only_and_duplicate_keys_rejected(self):
        for raw in ("Agent says success", json.dumps(success()), json.dumps({"result_json": envelope(success())}), json.dumps({"REASONING_CONTENT": envelope(success())}), '{"isError":true,"isError":false,"content":[]}'):
            with self.subTest(raw=raw):
                with patch.object(GATE, "_now", return_value=NOW):
                    self.assertNotVerified(GATE.main(raw, REPO, JOB, REQUEST), "invalid_evidence")

    def test_transport_error_veto(self):
        with patch.object(GATE, "_now", return_value=NOW):
            self.assertNotVerified(GATE.main(envelope(success(), is_error=True), REPO, JOB, REQUEST), "tool_error")

    def test_top_ok_and_job_result_are_not_pass_verdicts(self):
        for mutate in (lambda p: p.update(ok=1), lambda p: p["job"].update(terminal=1), lambda p: p["job"].update(status="running"), lambda p: p["job"]["result"].update(ok="true"), lambda p: p["job"]["result"].pop("repair")):
            payload = success()
            mutate(payload)
            self.assertNotVerified(render(payload))

    def test_current_id_repo_and_url_are_exactly_bound(self):
        for mutate in (lambda p: p["job"].update(job_id="N" * 43), lambda p: p["job"]["result"]["repair"]["repository"].update(url="https://github.com/other/repo"), lambda p: p["job"]["result"]["repair"]["repository"].update(slug="other/repo")):
            payload = success()
            mutate(payload)
            self.assertNotVerified(render(payload), "parameter_mismatch")
        for repo in (REPO + "/", REPO + "?x=1", "https://github.com@evil.example/a/b", REPO + ".git"):
            self.assertNotVerified(render(success(), repo=repo), "parameter_mismatch")

    def test_missing_timestamps_and_old_run_fail_closed(self):
        for field in ("started_at", "completed_at"):
            payload = success()
            del payload["job"]["result"]["repair"][field]
            self.assertNotVerified(render(payload), "missing_freshness_evidence")
        payload = success()
        payload["job"]["result"]["repair"]["started_at"] = "2026-09-12T14:59:03Z"
        self.assertNotVerified(render(payload), "stale_evidence")

    def test_two_second_skew_but_never_future_or_reverse_time(self):
        for started, completed, expected in (("2026-10-03T11:58:58Z", "2026-10-03T11:59:20Z", "verified_repair"), ("2026-10-03T11:58:57.999Z", "2026-10-03T11:59:20Z", "stale_evidence"), ("2026-10-03T12:00:01Z", "2026-10-03T12:00:02Z", "stale_evidence"), ("2026-10-03T11:59:10Z", "2026-10-03T12:00:01Z", "stale_evidence"), ("2026-10-03T11:59:20Z", "2026-10-03T11:59:10Z", "stale_evidence")):
            payload = success()
            payload["job"]["result"]["repair"].update(started_at=started, completed_at=completed)
            sync_artifact(payload)
            self.assertEqual(render(payload)["status"], expected)
        self.assertNotVerified(render(success(), request="2026-10-03T12:00:01Z"), "parameter_mismatch")

    def test_required_repair_fields_and_verdict_types(self):
        for key in ("schema_version", "verified_repair", "status", "verifier_backend", "baseline", "final_verification", "changed_files", "patch_sha256", "attestation_sha256", "run_id"):
            payload = success()
            del payload["job"]["result"]["repair"][key]
            self.assertNotVerified(render(payload), "invalid_evidence")
        for value in ("true", 1, None):
            payload = success()
            payload["job"]["result"]["repair"]["verified_repair"] = value
            self.assertNotVerified(render(payload), "invalid_evidence")

    def test_every_phase_and_execution_field_required(self):
        for name in ("baseline", "final_verification"):
            for key in ("status", "verified", "backend", "command", "verification_scope", "repair_evidence_eligible", "install", "execution"):
                payload = success()
                del payload["job"]["result"]["repair"][name][key]
                self.assertNotVerified(render(payload), "invalid_evidence")
            for phase_name in ("install", "execution"):
                for key in ("exit_code", "timed_out", "duration_seconds", "stdout", "stderr"):
                    payload = success()
                    del payload["job"]["result"]["repair"][name][phase_name][key]
                    self.assertNotVerified(render(payload), "invalid_evidence")

    def test_boolean_integer_confusion_timeouts_and_install_failures(self):
        for field, value in (("exit_code", False), ("timed_out", 0), ("duration_seconds", True), ("timed_out", True)):
            payload = success()
            payload["job"]["result"]["repair"]["final_verification"]["execution"][field] = value
            self.assertNotVerified(render(payload), "invalid_evidence")
        payload = success()
        payload["job"]["result"]["repair"]["baseline"]["install"]["exit_code"] = 1
        self.assertNotVerified(render(payload), "invalid_evidence")

    def test_same_command_original_failure_final_pass(self):
        for phase_name, field, value in (("baseline", "verified", True), ("baseline", "command", "pytest"), ("final_verification", "command", "python -m pytest -q --ignore=tests"), ("final_verification", "verified", False), ("final_verification", "repair_evidence_eligible", False)):
            payload = success()
            payload["job"]["result"]["repair"][phase_name][field] = value
            self.assertNotVerified(render(payload), "invalid_evidence")
        for phase_name, exit_code in (("baseline", 0), ("final_verification", 1)):
            payload = success()
            payload["job"]["result"]["repair"][phase_name]["execution"]["exit_code"] = exit_code
            self.assertNotVerified(render(payload), "invalid_evidence")

    def test_complete_consistent_pytest_and_not_reduced_scope(self):
        for key in ("completed", "collected", "passed", "failed", "skipped", "errors", "runner_exit_code"):
            payload = success()
            del payload["job"]["result"]["repair"]["final_verification"]["execution"]["pytest_attestation"][key]
            self.assertNotVerified(render(payload), "invalid_evidence")
        for updates in ({"collected": 0, "passed": 0}, {"collected": 2, "passed": 2}, {"skipped": 1, "passed": 2}, {"failed": 1, "passed": 2}, {"runner_exit_code": False}, {"passed": True}, {"collected": 4}):
            payload = success()
            payload["job"]["result"]["repair"]["final_verification"]["execution"]["pytest_attestation"].update(updates)
            self.assertNotVerified(render(payload), "invalid_evidence")

    def test_truncated_logs_and_optional_incomplete_flags_fail_closed(self):
        for updates in ({"stdout": "partial\n[output truncated after 65536 characters]"}, {"stdout_truncated": True}, {"stderr_complete": False}):
            payload = success()
            payload["job"]["result"]["repair"]["final_verification"]["execution"].update(updates)
            self.assertNotVerified(render(payload), "invalid_evidence")

    def test_artifact_evidence_not_interchangeable_or_mutable(self):
        for mutate in (lambda a: a.pop("artifact_contents"), lambda a: a["artifact_contents"].update(patch=PATCH + "# wrong"), lambda a: a["artifact_contents"].update(evidence="{}"), lambda a: a["artifact_contents"].update(report="different run"), lambda a: a["files"]["repair.patch"].update(bytes=True), lambda a: a.update(repository="other/private")):
            payload = success()
            mutate(payload["job"]["result"]["github_actions"])
            self.assertNotVerified(render(payload), "invalid_evidence")

    def test_changed_files_and_patch_cannot_claim_tests_unchanged(self):
        for paths in ([], ["tests/test_parser.py"], ["pyproject.toml"], ["../parser.py"], ["src/parser.py", "src/parser.py"], ["src/other.py"], [{}]):
            payload = success()
            payload["job"]["result"]["repair"]["changed_files"] = paths
            sync_artifact(payload)
            self.assertNotVerified(render(payload), "invalid_evidence")

    def test_bad_receipt_origins_paths_query_and_signed_shape_not_published(self):
        for value in (RECEIPT.replace("https:", "http:"), RECEIPT.replace(GATE.RECEIPT_HOST, "evil.example"), RECEIPT.replace(GATE.RECEIPT_HOST, GATE.RECEIPT_HOST + ".evil.example"), RECEIPT.replace("/r/", "/private/"), RECEIPT + "?token=private", RECEIPT + "#private", "https://user:password@" + GATE.RECEIPT_HOST + "/r/x", "https://[", "/r/fabricated", None):
            result = render(success(), value)
            self.assertNotVerified(result, "invalid_evidence")
            if isinstance(value, str):
                self.assertNotIn(value, result["report"])

    def test_receipt_must_reference_this_actions_run_and_artifact(self):
        for value in (RECEIPT.replace("v1.123.456.", "v1.999.456."), RECEIPT.replace("v1.123.456.", "v1.123.888.")):
            result = render(success(), value)
            self.assertNotVerified(result, "invalid_evidence")
            self.assertNotIn(value, result["report"])

    def test_pending_failed_unknown_and_not_allowed_never_verify(self):
        for status in GATE.PENDING:
            payload = {"ok": True, "job": {"job_id": JOB, "operation": "verify_github_patch", "status": status, "terminal": False}}
            self.assertNotVerified(render(payload), "queued")
        for status in ("unknown_job", "repository_not_allowed", "provider_unavailable"):
            self.assertNotVerified(render({"ok": False, "status": status, "message": "private " + JOB}), status if status != "provider_unavailable" else "failed")
        payload = success()
        payload["job"].update(status="failed")
        self.assertNotVerified(render(payload), "failed")

    def test_preparation_cannot_inherit_verified_repair_claim(self):
        for status, repairable, expected in (("already_passing", False, "already_passing"), ("repair_ready", True, "preparation_ready"), ("reproduction_failed", False, "preparation_unverified")):
            payload = {"ok": True, "job": {"job_id": JOB, "operation": "prepare_github_repair", "status": "succeeded", "terminal": True, "result": {"ok": True, "preparation": {"repository": {"url": REPO, "slug": "wenjieding327/repo-rescue-canary"}, "status": status, "repairable": repairable}}}}
            self.assertNotVerified(render(payload), expected)

    def test_backend_false_verdict_is_honest(self):
        for status, expected in (("repair_failed", "failed"), ("repair_tests_passed_uncompared", "repair_unverified"), ("already_passing", "already_passing"), ("verified_repair", "invalid_evidence")):
            payload = success()
            payload["job"]["result"]["repair"].update(verified_repair=False, status=status)
            self.assertNotVerified(render(payload), expected)

    def test_logs_hide_capability_and_private_link_without_inventing_output(self):
        payload = success()
        repair = payload["job"]["result"]["repair"]
        repair["baseline"]["execution"]["stderr"] = "job=" + JOB + " https://private.example/r/internal?token=secret"
        sync_artifact(payload)
        result = render(payload)
        self.assertEqual(result["status"], "verified_repair")
        self.assertNotIn(JOB, result["report"])
        self.assertNotIn("private.example", result["report"])
        self.assertNotIn("token=secret", result["report"])
        self.assertIn("日志链接已隐藏", result["report"])

    def test_transport_artifact_descriptor_difference_is_permitted_only_at_root(self):
        payload = success()
        payload["job"]["result"]["repair"]["artifacts"] = {"retrieval_tool": "github_actions"}
        self.assertEqual(render(payload)["status"], "verified_repair")
        payload["job"]["result"]["repair"]["baseline"]["new_unbound_field"] = 1
        self.assertNotVerified(render(payload), "invalid_evidence")

    def test_deterministic_and_non_mutating(self):
        payload = success()
        snapshot = copy.deepcopy(payload)
        self.assertEqual(render(payload), render(payload))
        self.assertEqual(payload, snapshot)

    def test_non_finite_numbers_surrogates_and_huge_durations_fail_closed(self):
        for value in (10 ** 400, float("inf")):
            payload = success()
            payload["job"]["result"]["repair"]["baseline"]["execution"]["duration_seconds"] = value
            self.assertNotVerified(render(payload), "invalid_evidence")
        payload = success()
        payload["job"]["result"]["github_actions"]["artifact_contents"]["patch"] = "\ud800"
        self.assertNotVerified(render(payload), "invalid_evidence")
        inner = json.dumps(success()).replace('"ok": true', '"ok": true, "invalid_number": 1e999', 1)
        raw = json.dumps({"isError": False, "content": [{"type": "text", "text": inner}]})
        with patch.object(GATE, "_now", return_value=NOW):
            self.assertNotVerified(GATE.main(raw, REPO, JOB, REQUEST), "invalid_evidence")


if __name__ == "__main__":
    unittest.main()
