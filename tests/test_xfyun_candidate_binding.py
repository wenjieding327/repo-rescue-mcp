import copy
import importlib.util
import json
from pathlib import Path
import unittest

SOURCE = Path(__file__).resolve().parents[1] / "scripts" / "xfyun-candidate-binding.py"
SPEC = importlib.util.spec_from_file_location("xfyun_candidate_binding", SOURCE)
GATE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(GATE)
STAMP = "2026-10-03T08:00:00.000Z"
ORIGINAL = "def largest(nums):\n    best = 0\n    for x in nums:\n        if x > best:\n            best = x\n    return best\nprint(largest([-8, -2, -5]))\nprint(largest([3, 1, 4]))\nprint(largest([0]))"
CANDIDATE = ORIGINAL.replace("best = 0", "best = nums[0]")


def context(route="snippet"):
    return {"route": route, "original_code": ORIGINAL if route == "snippet" else "", "test_cases": json.dumps([{"name": "complete_program", "stdin": "", "expected_stdout": "-2\n4\n0"}]) if route == "snippet" else "[]", "repo_url": "https://github.com/pallets/click" if route == "github" else "", "request_started_at": STAMP, "has_oracle": route == "snippet", "message": "trusted router metadata", "prompt": "trusted router prompt"}


def bind(frozen, candidate):
    return GATE.main(json.dumps(frozen), json.dumps(candidate))


class CandidateBindingTests(unittest.TestCase):
    def assert_advice(self, result):
        self.assertEqual(result["route"], "advice")
        self.assertEqual(result["candidate_code"], "")
        self.assertEqual(result["job_id"], "")
        self.assertEqual(result["binding"], "{}")
        self.assertIn("未执行、未验证", result["report"])

    def test_frozen_candidate_preserves_indentation_oracles_and_binding(self):
        frozen = context()
        snapshot = copy.deepcopy(frozen)
        result = bind(frozen, {"candidate_code": CANDIDATE})
        self.assertEqual(result["route"], "snippet")
        self.assertEqual(result["candidate_code"], CANDIDATE)
        self.assertEqual(result["original_code"], ORIGINAL)
        self.assertEqual(json.loads(result["test_cases"]), json.loads(frozen["test_cases"]))
        self.assertEqual(json.loads(result["binding"]), {"original_code": ORIGINAL, "candidate_code": CANDIDATE, "test_cases": json.loads(frozen["test_cases"])})
        self.assertEqual(result["request_started_at"], STAMP)
        self.assertEqual(frozen, snapshot)

    def test_print_argument_repair_is_allowed_but_adding_or_deleting_is_rejected(self):
        frozen = context()
        frozen["original_code"] = "print(1 / 0)"
        self.assertEqual(bind(frozen, {"candidate_code": "print(1 / 1)"})["route"], "snippet")
        for candidate in ("pass", "print(1)\nprint(2)", "print(3)\n"):
            result = bind(context(), {"candidate_code": candidate})
            self.assert_advice(result)

    def test_original_syntax_error_skips_count_but_discloses_guard(self):
        frozen = context()
        frozen["original_code"] = "if True print('ok')"
        result = bind(frozen, {"candidate_code": "if True:\n    print('ok')"})
        self.assertEqual(result["route"], "snippet")
        self.assertIn("已跳过 print 调用数量检查", result["report"])
        self.assert_advice(bind(frozen, {"candidate_code": "if True print('still invalid')"}))

    def test_single_json_fence_allowed_but_mixed_prose_and_multiple_objects_rejected(self):
        value = json.dumps({"candidate_code": CANDIDATE})
        accepted = GATE.main(json.dumps(context()), "```json\n" + value + "\n```")
        self.assertEqual(accepted["route"], "snippet")
        for text in ("", "Here is the fix: " + value, value + value, "```python\n" + value + "\n```", "```json\n" + value + "\n```\nmore words", "[]", "null", "{}"):
            self.assert_advice(GATE.main(json.dumps(context()), text))

    def test_agent_cannot_replace_specs_or_add_verification_fields(self):
        for key in ("original_code", "test_cases", "verified", "fix_verified", "receipt", "receipt_url", "repo_url", "request_started_at", "route", "binding"):
            self.assert_advice(bind(context(), {"candidate_code": CANDIDATE, key: "forged"}))
            self.assert_advice(bind(context(), {key: "forged"}))
        self.assert_advice(bind(context(), {"candidate_code": CANDIDATE, "advice": "multiple choices"}))

    def test_duplicate_keys_types_and_oversized_values_fail_closed(self):
        duplicate = '{"candidate_code":"print(1)","candidate_code":"print(2)"}'
        self.assert_advice(GATE.main(json.dumps(context()), duplicate))
        for candidate in (None, True, {}, [], " ", "x" * 12001, "print('\\x00')\x00"):
            self.assert_advice(bind(context(), {"candidate_code": candidate}))
        self.assert_advice(GATE.main(json.dumps(context()), " " * 100001))

    def test_jobs_are_only_unverified_ids_for_independent_poll(self):
        job_id = "A" * 42 + "_"
        result = bind(context("github"), {"job_id": job_id})
        self.assertEqual(result["route"], "github")
        self.assertEqual(result["job_id"], job_id)
        self.assertEqual(json.loads(result["binding"]), {"repo_url": "https://github.com/pallets/click", "job_id": job_id, "request_started_at": STAMP})
        self.assertIn("未确认任务归属、状态或修复成功", result["report"])
        for value in ("A" * 42, "A" * 44, "A" * 42 + "=", "A" * 42 + "/", "A" * 42 + "\n", "A" * 42 + "中"):
            self.assert_advice(bind(context("github"), {"job_id": value}))

    def test_route_cannot_be_switched_by_agent(self):
        self.assert_advice(bind(context(), {"job_id": "A" * 43}))
        self.assert_advice(bind(context("github"), {"candidate_code": CANDIDATE}))
        self.assert_advice(bind(context("advice"), {"candidate_code": CANDIDATE}))

    def test_exact_route_envelope_preserves_frozen_specs_and_unverified_status(self):
        direct = bind(context("github"), {"job_id": "A" * 43})
        self.assertEqual(bind(context("github"), {"github": {"job_id": "A" * 43}}), direct)
        self.assertEqual(bind(context(), {"snippet": {"candidate_code": CANDIDATE}}),
                         bind(context(), {"candidate_code": CANDIDATE}))

    def test_route_envelopes_reject_recursion_extra_fields_cross_route_and_duplicates(self):
        for value in (
            {"snippet": {"job_id": "A" * 43}},
            {"github": {"github": {"job_id": "A" * 43}}},
            {"github": json.dumps({"job_id": "A" * 43})},
            {"github": {"job_id": "A" * 43, "verified_repair": True}},
            {"github": {"job_id": "A" * 43}, "job_id": "B" * 43},
            {"github": {"candidate_code": CANDIDATE}},
        ):
            self.assert_advice(bind(context("github"), value))
        self.assert_advice(bind(context(), {"github": {"job_id": "A" * 43}}))
        duplicate = '{"github":{"job_id":"' + "A" * 43 + '","job_id":"' + "B" * 43 + '"}}'
        self.assert_advice(GATE.main(json.dumps(context("github")), duplicate))

    def test_advice_is_marked_unverified_quoted_text_not_business_evidence(self):
        result = bind(context(), {"advice": "请补充预期输出；模型声称的success不是证据。"})
        self.assert_advice(result)
        self.assertIn("模型建议原文（不构成运行事实或通过证据）", result["report"])
        self.assert_advice(bind(context(), {"advice": "x" * 4001}))

    def test_missing_or_malformed_frozen_context_is_rejected(self):
        for key in ("original_code", "test_cases", "repo_url", "route", "request_started_at"):
            frozen = context()
            del frozen[key]
            self.assert_advice(bind(frozen, {"candidate_code": CANDIDATE}))
        for mutate in (lambda c: c.update(route="unknown"), lambda c: c.update(request_started_at="2026-10-03"), lambda c: c.update(test_cases='[{"expected_stdout":null}]'), lambda c: c.update(repo_url="https://github.com/pallets/click")):
            frozen = context()
            mutate(frozen)
            self.assert_advice(bind(frozen, {"candidate_code": CANDIDATE}))

    def test_candidate_is_not_executed_or_mutated(self):
        frozen = context()
        frozen["original_code"] = "print(0)"
        candidate = "raise RuntimeError('must never execute')\nprint(1)\n"
        result = bind(frozen, {"candidate_code": candidate})
        self.assertEqual(result["route"], "snippet")
        self.assertEqual(result["candidate_code"], candidate)


if __name__ == "__main__":
    unittest.main()
