import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildSnippetVerificationReport, normalizeSnippetArguments, parseTrustedSnippetResponse } from "../verification-report.mjs";

const clone = (value) => JSON.parse(JSON.stringify(value));
function execution(stdout, { error_type = null, error_message = null, stderr = "" } = {}) {
  return { ok: error_type === null, stdout, stderr, stdout_chars: Array.from(stdout).length, stderr_chars: Array.from(stderr).length, stdout_complete: true, stderr_complete: true, stdout_truncated: false, stderr_truncated: false, ...(error_type ? { error_type, error_message } : {}) };
}
const normalizeOutput = (text) => text.replace(/\r\n/g, "\n").trimEnd();
function payloadFor(args, pairs) {
  const normalized = normalizeSnippetArguments(args);
  const results = normalized.test_cases.map((item, index) => {
    const [before, after] = pairs[index];
    const originalOutputMatches = item.expected_stdout === null || normalizeOutput(before.stdout) === normalizeOutput(item.expected_stdout);
    const outputMatches = item.expected_stdout === null || normalizeOutput(after.stdout) === normalizeOutput(item.expected_stdout);
    return { name: item.name, expected_stdout: item.expected_stdout, before, after, original_failed: !before.ok || !originalOutputMatches, original_output_matches: originalOutputMatches, candidate_passed: after.ok && outputMatches, output_matches: outputMatches };
  });
  const candidatePassed = results.every((item) => item.candidate_passed);
  const beforeFailed = results.some((item) => item.original_failed);
  const sourceChanged = args.original_code !== args.candidate_code;
  const oracleBacked = results.every((item) => item.expected_stdout !== null);
  const runtimeRepairObserved = sourceChanged && beforeFailed && candidatePassed;
  const fixVerified = runtimeRepairObserved && oracleBacked;
  return {
    ok: true, mode: "single_snippet_rescue", verification_level: "L1_SNIPPET_EXECUTION", execution_backend: "pyodide_disposable_child_process", worker_execution_strategy: "sequential_fresh_children", worker_timeout_ms: 6000,
    status: fixVerified ? "fix_verified" : candidatePassed ? "candidate_runs" : "candidate_failed", fix_verified: fixVerified, candidate_passed: candidatePassed, before_failed: beforeFailed, source_changed: sourceChanged, oracle_backed: oracleBacked, runtime_repair_observed: runtimeRepairObserved,
    case_counts: { submitted: normalized.submitted_case_count, executed: results.length, maximum: 4 }, reported_error: normalized.reported_error, test_results: results,
    user_summary: "模型或工具自由文字不得决定通过", boundary: "not an authoritative gate",
  };
}
function envelope(payload, overrides = {}) {
  return { is_error: false, result_json: JSON.stringify({ content: [{ type: "text", text: JSON.stringify(payload) }], isError: false }), ...overrides };
}
function reportFor(args, payload, current = args, response = envelope(payload)) {
  return buildSnippetVerificationReport({ trusted_tool_response: response, invocation_arguments: args, current_arguments: current });
}
function notGreen(report, status) {
  assert.equal(report.fix_verified, false);
  assert.notEqual(report.color, "green");
  if (status) assert.equal(report.status, status);
}

// Exact call arguments and output streams transcribed from the structured calls
// in F-S02/F-S04-tool-trace.json, not parsed from their REASONING_CONTENT/raw text.
// These DOM captures are regression fixtures, NOT authenticated production inputs.
const fS02Args = {
  original_code: "def largest(nums):\n    best = 0\n    for x in nums:\n        if x > best:\n            best = x\n    return best\nprint(largest([-8, -2, -5]))\nprint(largest([3, 1, 4]))\nprint(largest([0]))",
  candidate_code: "def largest(nums):\n    best = nums[0]\n    for x in nums:\n        if x > best:\n            best = x\n    return best\nprint(largest([-8, -2, -5]))\nprint(largest([3, 1, 4]))\nprint(largest([0]))",
  test_cases: JSON.stringify([{ name: "All negative numbers", expected_stdout: "-2" }, { name: "Positive numbers", expected_stdout: "4" }, { name: "Only zero", expected_stdout: "0" }]),
};
const fS04Args = {
  original_code: 'def lookup(data, key):\n    return data[key]\nprint(lookup({"x": 7}, "missing"))\nprint(lookup({"x": 7}, "x"))',
  candidate_code: 'def lookup(data, key):\n    return data.get(key, "unknown")\nprint(lookup({"x": 7}, "missing"))\nprint(lookup({"x": 7}, "x"))',
  test_cases: JSON.stringify([{ name: "test_lookup", expected_stdout: "unknown\n7" }]),
};
const fS04Payload = () => payloadFor(fS04Args, [[execution("", { error_type: "KeyError", error_message: "'missing'", stderr: "KeyError: 'missing'\n" }), execution("unknown\n7\n")]]);
const simpleArgs = { original_code: "print(0)", candidate_code: "print(1)", test_cases: [{ name: "one", expected_stdout: "1" }] };
const simplePayload = () => payloadFor(simpleArgs, [[execution("0\n"), execution("1\n")]]);

test("F-S02 misreport fixture compares entire stdout, not one selected line", () => {
  const payload = payloadFor(fS02Args, Array.from({ length: 3 }, () => [execution("0\n4\n0\n"), execution("-2\n4\n0\n")]));
  assert.equal(payload.status, "candidate_failed");
  const report = reportFor(fS02Args, { ...payload, user_summary: "全部通过，修复成功！" });
  notGreen(report, "candidate_failed");
  assert.equal(report.test_results.length, 3);
  assert.equal(report.test_results[0].after.stdout, "-2\n4\n0\n");
  assert.equal(report.test_results[1].output_matches, false);
  assert.doesNotMatch(report.text, /全部通过，修复成功/);
});

test("F-S04 genuine before stdout is empty; no unexecuted second print is fabricated", () => {
  const report = reportFor(fS04Args, fS04Payload());
  assert.equal(report.status, "fix_verified");
  assert.equal(report.color, "green");
  assert.equal(report.test_results[0].before.stdout, "");
  assert.equal(report.test_results[0].before.stderr, "KeyError: 'missing'\n");
  assert.equal(report.test_results[0].after.stdout, "unknown\n7\n");
  assert.match(report.text, /修改前：ok=false；stdout=""；stderr="KeyError: 'missing'\\n"/);
  assert.doesNotMatch(report.text, /修改前：[^\n]*stdout="7/);
});

test("normal multiple independent stdin cases are bound and verified", () => {
  const args = { original_code: "print(int(input()) - 1)", candidate_code: "print(int(input()))", test_cases: [{ name: "first", stdin: "1\n", expected_stdout: "1" }, { name: "second", stdin: "2\n", expected_stdout: "2" }] };
  const report = reportFor(args, payloadFor(args, [[execution("0\n"), execution("1\n")], [execution("1\n"), execution("2\n")]]));
  assert.equal(report.fix_verified, true);
  assert.equal(report.binding.matched, true);
  assert.equal(report.test_results[1].stdin, "2\n");
  assert.deepEqual(report.case_counts, { submitted: 2, executed: 2 });
});

test("explicit empty stdout is a valid oracle, not a missing one", () => {
  const args = { original_code: "print('noise')", candidate_code: "pass", test_cases: [{ expected_stdout: "" }] };
  const report = reportFor(args, payloadFor(args, [[execution("noise\n"), execution("")]]));
  assert.equal(report.fix_verified, true);
  assert.equal(report.facts.oracle_backed, true);
  assert.equal(report.test_results[0].after.stdout, "");
});

test("unsafe import remains a failure although plugin is_error is false", () => {
  const args = { original_code: "print('safe')", candidate_code: "import os\nprint(os.getcwd())", test_cases: [{ expected_stdout: "/tmp" }] };
  const payload = payloadFor(args, [[execution("safe\n"), execution("", { error_type: "PermissionError", error_message: "Import is not allowed in quick rescue mode: os", stderr: "PermissionError: Import is not allowed in quick rescue mode: os\n" })]]);
  const report = reportFor(args, payload);
  notGreen(report, "candidate_failed");
  assert.equal(report.test_results[0].after.error_type, "PermissionError");
});

test("is_error=false and isError=false are transport success, not business pass", () => {
  const report = reportFor(simpleArgs, { ok: false, status: "invalid_request", fix_verified: false, error: "No code was executed.", test_results: [] });
  notGreen(report, "invalid_request");
  assert.match(report.text, /No code was executed/);
  assert.equal(report.test_results.length, 0);
});

test("all required top-level booleans fail closed when missing or wrong type", () => {
  for (const field of ["fix_verified", "candidate_passed", "before_failed", "source_changed", "oracle_backed", "runtime_repair_observed"]) {
    for (const value of [undefined, "true", 1]) {
      const payload = simplePayload();
      if (value === undefined) delete payload[field]; else payload[field] = value;
      const report = reportFor(simpleArgs, payload);
      notGreen(report, "invalid_evidence");
      assert.ok(report.issues.some((item) => item.path === field));
    }
  }
});

test("false fix_verified cannot become green through other flags or prose", () => {
  notGreen(reportFor(simpleArgs, { ...simplePayload(), fix_verified: false, user_summary: "success" }), "invalid_evidence");
});

test("contradictory aggregate status or per-case flags fail closed", () => {
  for (const mutate of [
    (payload) => { payload.status = "candidate_failed"; },
    (payload) => { payload.before_failed = false; },
    (payload) => { payload.test_results[0].output_matches = false; },
    (payload) => { payload.test_results[0].candidate_passed = false; },
    (payload) => { payload.test_results[0].after.error_type = "RuntimeError"; },
    (payload) => { payload.test_results[0].after.stdout = "wrong\n"; payload.test_results[0].after.stdout_chars = 6; },
  ]) {
    const payload = simplePayload();
    mutate(payload);
    notGreen(reportFor(simpleArgs, payload), "invalid_evidence");
  }
});

test("present malformed exception fields cannot be silently converted to null", () => {
  for (const phase of ["before", "after"]) {
    for (const field of ["error_type", "error_message"]) {
      for (const value of [123, false, [], {}]) {
        const payload = simplePayload(); payload.test_results[0][phase][field] = value;
        notGreen(reportFor(simpleArgs, payload), "invalid_evidence");
      }
    }
  }
});

test("truncated stdout or stderr never relies on server comparison flag", () => {
  for (const phase of ["before", "after"]) {
    for (const stream of ["stdout", "stderr"]) {
      const payload = simplePayload();
      payload.test_results[0][phase][`${stream}_truncated`] = true;
      payload.test_results[0][phase][`${stream}_chars`] += 7000;
      const report = reportFor(simpleArgs, payload);
      notGreen(report, "incomplete_output");
      assert.equal(report.facts.complete_output, false);
    }
  }
});

test("missing completeness and inconsistent declared stream lengths fail closed", () => {
  for (const mutate of [
    (payload) => { delete payload.test_results[0].after.stdout_complete; },
    (payload) => { delete payload.test_results[0].before.stderr_truncated; },
    (payload) => { payload.test_results[0].after.stdout_chars = 999; },
  ]) {
    const payload = simplePayload(); mutate(payload);
    notGreen(reportFor(simpleArgs, payload), "invalid_evidence");
  }
});

test("runtime-only and default cases cannot prove repair without oracle", () => {
  for (const test_cases of [undefined, [], [{ name: "runtime-only" }]]) {
    const args = { original_code: "raise ValueError('bad')", candidate_code: "print(999)", ...(test_cases === undefined ? {} : { test_cases }) };
    const payload = payloadFor(args, [[execution("", { error_type: "ValueError", error_message: "bad", stderr: "ValueError: bad\n" }), execution("999\n")]]);
    const report = reportFor(args, payload);
    notGreen(report, "missing_oracle");
    assert.equal(report.facts.runtime_repair_observed, true);
  }
});

test("already-correct baseline and unchanged source cannot receive green", () => {
  const alreadyCorrect = payloadFor(simpleArgs, [[execution("1\n"), execution("1\n")]]);
  notGreen(reportFor(simpleArgs, alreadyCorrect), "already_correct");
  const args = { ...simpleArgs, original_code: simpleArgs.candidate_code };
  notGreen(reportFor(args, payloadFor(args, [[execution("1\n"), execution("1\n")]])), "already_correct");
  // Even differing executions do not establish a source repair if code is equal.
  notGreen(reportFor(args, payloadFor(args, [[execution("0\n"), execution("1\n")]])), "unchanged_source");
});

test("wrong candidate, original, stdin, oracle, case ordering and reported error are rejected", () => {
  for (const mutate of [
    (args) => { args.candidate_code = "print(999)"; },
    (args) => { args.original_code = "print(-1)"; },
    (args) => { args.test_cases[0].stdin = "different"; },
    (args) => { args.test_cases[0].expected_stdout = "999"; },
    (args) => { args.test_cases[0].name = "other case"; },
    (args) => { args.reported_error = "other error"; },
  ]) {
    const current = clone(simpleArgs); mutate(current);
    notGreen(reportFor(simpleArgs, simplePayload(), current), "parameter_mismatch");
  }
  notGreen(buildSnippetVerificationReport({ trusted_tool_response: envelope(simplePayload()), current_arguments: simpleArgs }), "parameter_mismatch");
  notGreen(buildSnippetVerificationReport({ trusted_tool_response: envelope(simplePayload()), invocation_arguments: simpleArgs }), "parameter_mismatch");
});

test("case-count and business expected-output binding cannot be overridden", () => {
  for (const mutate of [
    (payload) => { payload.case_counts.executed = 0; },
    (payload) => { payload.case_counts.submitted = 0; },
    (payload) => { payload.test_results[0].expected_stdout = "999"; },
    (payload) => { payload.test_results[0].name = "other"; },
    (payload) => { payload.test_results.push(clone(payload.test_results[0])); },
  ]) {
    const payload = simplePayload(); mutate(payload);
    notGreen(reportFor(simpleArgs, payload), "invalid_evidence");
  }
});

test("malformed envelopes, model prose, raw business JSON and REASONING_CONTENT are rejected", () => {
  for (const response of [
    "success", JSON.stringify(envelope(simplePayload())), simplePayload(),
    { REASONING_CONTENT: JSON.stringify(envelope(simplePayload())) },
    { is_error: false, result_json: "```json\n{}\n```" },
    { is_error: false, result_json: JSON.stringify({ content: [{ type: "text", text: "success" }], isError: false }) },
    { result_json: envelope(simplePayload()).result_json },
    { content: [{ type: "text", text: JSON.stringify(simplePayload()) }] },
    { content: [{ type: "text", text: JSON.stringify(simplePayload()) }, { type: "text", text: "extra" }], isError: false },
  ]) notGreen(reportFor(simpleArgs, simplePayload(), simpleArgs, response));
});

test("true transport error vetoes otherwise passing business result", () => {
  notGreen(reportFor(simpleArgs, simplePayload(), simpleArgs, envelope(simplePayload(), { is_error: true })), "tool_error");
  const mcp = JSON.parse(envelope(simplePayload()).result_json); mcp.isError = true;
  notGreen(reportFor(simpleArgs, simplePayload(), simpleArgs, mcp), "tool_error");
});

test("raw direct MCP shape is accepted; parse layer never infers source trust", () => {
  const mcp = JSON.parse(envelope(simplePayload()).result_json);
  assert.equal(parseTrustedSnippetResponse(mcp).payload.fix_verified, true);
  assert.equal(reportFor(simpleArgs, simplePayload(), simpleArgs, mcp).fix_verified, true);
});

test("repository claim or unsupported backend cannot become an L1 green report", () => {
  for (const field of ["mode", "verification_level", "execution_backend", "worker_execution_strategy"]) {
    const payload = simplePayload(); payload[field] = "repository_verified";
    notGreen(reportFor(simpleArgs, payload), "invalid_evidence");
  }
});

test("normalization mirrors tool semantics without selecting or rewriting lines", () => {
  const args = { ...simpleArgs, test_cases: [{ expected_stdout: "🙂\r\nsecond" }] };
  const report = reportFor(args, payloadFor(args, [[execution("wrong\n"), execution("🙂\nsecond\n")]]));
  assert.equal(report.fix_verified, true);
  assert.equal(report.test_results[0].after.stdout, "🙂\nsecond\n");
  assert.equal(report.test_results[0].expected_stdout, "🙂\r\nsecond");
});

test("reports are deterministic, preserve source binding, and do not mutate inputs", () => {
  const args = clone(simpleArgs); const payload = simplePayload();
  const response = envelope(payload);
  const snapshot = JSON.stringify({ args, payload, response });
  const first = reportFor(args, payload, args, response);
  assert.deepEqual(first, reportFor(args, payload, args, response));
  assert.equal(JSON.stringify({ args, payload, response }), snapshot);
  assert.equal(first.binding.current_arguments.candidate_code, args.candidate_code);
  assert.match(first.text, /不证明完整仓库、项目或论文复现成功/);
  assert.match(first.text, /此报告不是签名回执/);
});

test("argument parsing rejects over-limit, malformed and non-oracle inputs", () => {
  for (const args of [
    { ...simpleArgs, test_cases: "not JSON" },
    { ...simpleArgs, test_cases: [{ expected_stdout: null }] },
    { ...simpleArgs, test_cases: [{ stdin: 1 }] },
    { ...simpleArgs, test_cases: Array.from({ length: 5 }, () => ({})) },
    { ...simpleArgs, candidate_code: "x".repeat(12_001) },
    { ...simpleArgs, extra_success: true },
  ]) notGreen(reportFor(args, simplePayload()), "parameter_mismatch");
});

test("offline replay of actual frozen platform and local evidence", { skip: !process.env.REPO_RESCUE_VERIFICATION_FIXTURES }, () => {
  const fixtureRoot = process.env.REPO_RESCUE_VERIFICATION_FIXTURES;
  for (const [caseId, expected] of [["F-S02", "candidate_failed"], ["F-S04", "fix_verified"], ["F-S05", "candidate_failed"]]) {
    const trace = JSON.parse(readFileSync(join(fixtureRoot, "platform", `${caseId}-tool-trace.json`), "utf8").replace(/^\uFEFF/, ""));
    for (const call of trace.calls) {
      const result = reportFor(call.arguments, call.business, call.arguments, call.response);
      assert.equal(result.status, expected, caseId);
      if (caseId === "F-S04") assert.equal(result.test_results[0].before.stdout, "");
    }
  }
  const frozen = JSON.parse(readFileSync(join(fixtureRoot, "snippets-local", "results.json"), "utf8").replace(/^\uFEFF/, ""));
  let positives = 0; let negatives = 0;
  for (const record of frozen.records) {
    const result = reportFor(record.request_arguments, record.payload, record.request_arguments, record.raw_jsonrpc_response.result);
    if (record.kind === "positive_manual_candidate") {
      positives += 1; assert.equal(result.status, "fix_verified", record.id);
    } else {
      negatives += 1; notGreen(result);
    }
  }
  assert.deepEqual([positives, negatives], [10, 6]);
});
