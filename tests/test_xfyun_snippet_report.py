"""Run: python -m unittest discover -s tests -p test_xfyun_snippet_report.py.

Optional offline replay: set REPO_RESCUE_VERIFICATION_FIXTURES to the frozen
verification-20261003 directory. JSON fixtures are historical evidence, never a
trusted production source. No network or snippet execution occurs in this suite.
"""
import copy
import importlib.util
import json
import os
from pathlib import Path
import unittest

SOURCE = Path(__file__).resolve().parents[1] / "scripts" / "xfyun-snippet-report.py"
SPEC = importlib.util.spec_from_file_location("xfyun_snippet_report", SOURCE)
GATE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(GATE)


def execution(stdout, error_type=None, error_message=None, stderr=""):
    result = {"ok": error_type is None, "stdout": stdout, "stderr": stderr, "stdout_chars": len(stdout), "stderr_chars": len(stderr), "stdout_complete": True, "stderr_complete": True, "stdout_truncated": False, "stderr_truncated": False}
    if error_type:
        result.update(error_type=error_type, error_message=error_message)
    return result


ARGS = {"original_code": "print(0)", "candidate_code": "print(1)", "test_cases": [{"name": "one", "expected_stdout": "1"}]}


def payload_for(args, pairs):
    submitted, cases = GATE._arguments(args["original_code"], args["candidate_code"], args.get("test_cases"))
    results = []
    for case, (before, after) in zip(cases, pairs):
        oracle = case["expected_stdout"]
        original_matches = oracle is None or GATE._normalize_output(before["stdout"]) == GATE._normalize_output(oracle)
        matches = oracle is None or GATE._normalize_output(after["stdout"]) == GATE._normalize_output(oracle)
        results.append({"name": case["name"], "expected_stdout": oracle, "before": before, "after": after, "original_failed": not before["ok"] or not original_matches, "original_output_matches": original_matches, "candidate_passed": after["ok"] and matches, "output_matches": matches})
    candidate_passed = all(case["candidate_passed"] for case in results)
    before_failed = any(case["original_failed"] for case in results)
    changed = args["original_code"] != args["candidate_code"]
    oracle_backed = all(case["expected_stdout"] is not None for case in cases)
    runtime_repair = changed and before_failed and candidate_passed
    verified = oracle_backed and runtime_repair
    return {"ok": True, "mode": "single_snippet_rescue", "verification_level": "L1_SNIPPET_EXECUTION", "execution_backend": "pyodide_disposable_child_process", "worker_execution_strategy": "sequential_fresh_children", "worker_timeout_ms": 6000, "status": "fix_verified" if verified else "candidate_runs" if candidate_passed else "candidate_failed", "fix_verified": verified, "candidate_passed": candidate_passed, "before_failed": before_failed, "source_changed": changed, "oracle_backed": oracle_backed, "runtime_repair_observed": runtime_repair, "case_counts": {"submitted": submitted, "executed": len(cases), "maximum": 4}, "reported_error": None, "test_results": results, "user_summary": "FAKE SUCCESS SHOULD NOT BE DISPLAYED"}


def simple_payload():
    return payload_for(ARGS, [(execution("0\n"), execution("1\n"))])


def mcp_json(payload, is_error=False):
    return json.dumps({"content": [{"type": "text", "text": json.dumps(payload)}], "isError": is_error})


def report(args, payload):
    return GATE.main(mcp_json(payload), args["original_code"], args["candidate_code"], args.get("test_cases"))


class SnippetReportTests(unittest.TestCase):
    def test_positive_and_boolean_outputs(self):
        result = report(ARGS, simple_payload())
        self.assertEqual(result["status"], "fix_verified")
        self.assertIs(result["retry_needed"], False)
        self.assertIn('候选代码（仅字符串展示，不在报告节点执行）："print(1)"', result["report"])
        self.assertNotIn("FAKE SUCCESS", result["report"])

    def test_multiple_cases(self):
        args = {**ARGS, "test_cases": [{"stdin": "1\n", "expected_stdout": "1"}, {"stdin": "2\n", "expected_stdout": "2"}]}
        self.assertEqual(report(args, payload_for(args, [(execution("0\n"), execution("1\n")), (execution("1\n"), execution("2\n"))]))["status"], "fix_verified")

    def test_empty_stdout_and_trim_end(self):
        args = {**ARGS, "candidate_code": "pass", "test_cases": [{"expected_stdout": ""}]}
        result = report(args, payload_for(args, [(execution("noise\n"), execution(""))]))
        self.assertEqual(result["status"], "fix_verified")
        self.assertIn('stdout=""', result["report"])
        self.assertEqual(GATE._normalize_output(" leading\r\ninside\n \ufeff"), " leading\ninside")
        self.assertEqual(GATE._normalize_output("one\u0085"), "one\u0085")
        self.assertEqual(GATE._normalize_output("one\u001c"), "one\u001c")

    def test_failures_and_missing_oracle(self):
        failure = payload_for(ARGS, [(execution("0\n"), execution("", "PermissionError", "not allowed", "PermissionError: not allowed\n"))])
        result = report(ARGS, failure)
        self.assertEqual(result["status"], "candidate_failed")
        self.assertIs(result["retry_needed"], True)
        args = {**ARGS, "test_cases": []}
        self.assertEqual(report(args, payload_for(args, [(execution("0\n"), execution("1\n"))]))["status"], "missing_oracle")

    def test_already_correct(self):
        self.assertEqual(report(ARGS, payload_for(ARGS, [(execution("1\n"), execution("1\n"))]))["status"], "already_correct")

    def test_missing_false_non_boolean_or_contradictory_fields(self):
        for key in ("fix_verified", "candidate_passed", "before_failed", "source_changed", "oracle_backed", "runtime_repair_observed"):
            for value in (None, "true", 1, False):
                with self.subTest(key=key, value=value):
                    payload = simple_payload()
                    if value is None:
                        del payload[key]
                    else:
                        payload[key] = value
                    self.assertEqual(report(ARGS, payload)["status"], "invalid_evidence")

    def test_malformed_exception_fields(self):
        for phase in ("before", "after"):
            for field in ("error_type", "error_message"):
                for value in (123, False, [], {}):
                    with self.subTest(phase=phase, field=field, value=value):
                        payload = simple_payload()
                        payload["test_results"][0][phase][field] = value
                        self.assertEqual(report(ARGS, payload)["status"], "invalid_evidence")

    def test_truncation_or_missing_output_metadata(self):
        for phase in ("before", "after"):
            for stream in ("stdout", "stderr"):
                with self.subTest(phase=phase, stream=stream):
                    payload = simple_payload()
                    payload["test_results"][0][phase][stream + "_truncated"] = True
                    payload["test_results"][0][phase][stream + "_chars"] += 7000
                    self.assertEqual(report(ARGS, payload)["status"], "incomplete_output")
        payload = simple_payload()
        del payload["test_results"][0]["after"]["stdout_complete"]
        self.assertEqual(report(ARGS, payload)["status"], "invalid_evidence")

    def test_invalid_json_content_model_prose_or_transport_error(self):
        for value in ("success", json.dumps(simple_payload()), json.dumps({"REASONING_CONTENT": mcp_json(simple_payload())}), "```json\n{}\n```", json.dumps({"content": [{"type": "text", "text": "success"}], "isError": False})):
            self.assertEqual(GATE.main(value, ARGS["original_code"], ARGS["candidate_code"], ARGS["test_cases"])["status"], "invalid_evidence")
        self.assertEqual(GATE.main(mcp_json(simple_payload(), True), ARGS["original_code"], ARGS["candidate_code"], ARGS["test_cases"])["status"], "tool_error")

    def test_parameter_case_binding_and_count(self):
        for mutate in (lambda p: p["test_results"][0].update(expected_stdout="999"), lambda p: p["test_results"][0].update(name="other"), lambda p: p["case_counts"].update(executed=False), lambda p: p.update(status="candidate_failed")):
            payload = simple_payload()
            mutate(payload)
            self.assertEqual(report(ARGS, payload)["status"], "invalid_evidence")
        self.assertEqual(GATE.main(mcp_json(simple_payload()), ARGS["original_code"], ARGS["original_code"], ARGS["test_cases"])["status"], "invalid_evidence")

    def test_missing_or_invalid_oracle_parameter(self):
        for cases in ("not JSON", [{"expected_stdout": None}], [{"stdin": 1}], [{}, {}, {}, {}, {}]):
            self.assertEqual(GATE.main(mcp_json(simple_payload()), ARGS["original_code"], ARGS["candidate_code"], cases)["status"], "parameter_mismatch")

    def test_determinism_and_non_mutation(self):
        payload = simple_payload()
        snapshot = copy.deepcopy(payload)
        first = report(ARGS, payload)
        self.assertEqual(first, report(ARGS, payload))
        self.assertEqual(payload, snapshot)
        self.assertIn("不证明完整仓库", first["report"])
        self.assertIn("trimEnd", first["report"])

    @unittest.skipUnless(os.environ.get("REPO_RESCUE_VERIFICATION_FIXTURES"), "set fixture root to replay frozen local evidence")
    def test_frozen_platform_and_actual_local_results(self):
        root = Path(os.environ["REPO_RESCUE_VERIFICATION_FIXTURES"])
        expected_status = {"F-S02": "candidate_failed", "F-S04": "fix_verified", "F-S05": "candidate_failed"}
        for case_id, expected in expected_status.items():
            trace = json.loads((root / "platform" / (case_id + "-tool-trace.json")).read_text(encoding="utf-8-sig"))
            for call in trace["calls"]:
                args = call["arguments"]
                result = GATE.main(call["response"]["result_json"], args["original_code"], args["candidate_code"], args["test_cases"])
                with self.subTest(case_id=case_id):
                    self.assertEqual(result["status"], expected)
                    self.assertIs(type(result["retry_needed"]), bool)
                    if case_id == "F-S04":
                        self.assertIn('修改前：ok=false；stdout=""', result["report"])
        frozen = json.loads((root / "snippets-local" / "results.json").read_text(encoding="utf-8-sig"))
        positives = negatives = 0
        for record in frozen["records"]:
            args = record["request_arguments"]
            result = GATE.main(json.dumps(record["raw_jsonrpc_response"]["result"]), args["original_code"], args["candidate_code"], args.get("test_cases"))
            with self.subTest(record=record["id"]):
                if record["kind"] == "positive_manual_candidate":
                    positives += 1
                    self.assertEqual(result["status"], "fix_verified")
                else:
                    negatives += 1
                    self.assertNotEqual(result["status"], "fix_verified")
        self.assertEqual((positives, negatives), (10, 6))


if __name__ == "__main__":
    unittest.main()
