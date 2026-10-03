/**
 * Pure, offline, fail-closed L1 snippet report gate. No code is executed here.
 *
 * Usage:
 *   buildSnippetVerificationReport({
 *     trusted_tool_response: directPluginEnvelopeOrMcpResult,
 *     invocation_arguments: argumentsSavedWithThatSameTrustedInvocation,
 *     current_arguments: argumentsForTheCandidateBeingReported,
 *   });
 *
 * TRUST BOUNDARY: the caller must authenticate the tool source and associate
 * invocation_arguments with its actual response. The current backend does not
 * echo source code or stdin; this module cannot independently authenticate that
 * association or prevent a caller from forging both inputs. A DOM trace,
 * REASONING_CONTENT, model prose, or a model-created JSON object is NOT a trusted
 * response. They must never be promoted to one in production. No text scraping,
 * recursive JSON searching, signed-receipt claim, or repository verification is
 * performed. The data-only interface and predicates can be ported to a code node.
 */

export const SNIPPET_REPORT_SCHEMA = "snippet-verification-report/v1";
export const SNIPPET_REPORT_BOUNDARY = "仅验证本次提交的 Python 片段和用例（L1）；不证明完整仓库、项目或论文复现成功。";
export const SNIPPET_BINDING_BOUNDARY = "调用方须保证工具来源可信，并把返回与同一次调用的参数绑定；此报告不是签名回执。";
export const SNIPPET_COMPARISON_BOUNDARY = "比较整段 stdout：CRLF 转 LF，再去除末尾空白（与工具 trimEnd 一致）；不抽取单行，空输出与纯末尾空白可能等价。";
export const SNIPPET_ORACLE_BOUNDARY = "预期输出须来自用户或独立规格；此模块只检查其存在与绑定，不证明 oracle 独立性。";
const MAX_CASES = 4;
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const normalizeOutput = (value) => value.replace(/\r\n/g, "\n").trimEnd();
const issue = (code, path, message) => ({ code, path, message });

/** Only the two documented direct tool shapes are accepted, never free text. */
export function parseTrustedSnippetResponse(response) {
  const issues = [];
  let mcp = response;
  if (!object(response)) {
    return { payload: null, issues: [issue("invalid_envelope", "trusted_tool_response", "需要直接工具返回对象，不能使用模型文本。")], transport_ok: false };
  }
  let transportOk = true;
  if (own(response, "result_json")) {
    if (typeof response.is_error !== "boolean") issues.push(issue("missing_transport_flag", "is_error", "插件错误标志缺失或类型错误。"));
    if (response.is_error !== false) transportOk = false;
    try {
      if (typeof response.result_json !== "string") throw new Error();
      mcp = JSON.parse(response.result_json);
    } catch {
      issues.push(issue("invalid_result_json", "result_json", "插件 result_json 不是有效 JSON 字符串。"));
      return { payload: null, issues, transport_ok: false };
    }
  }
  if (!object(mcp) || typeof mcp.isError !== "boolean") {
    issues.push(issue("invalid_mcp_result", "isError", "MCP 结果或错误标志缺失。"));
    transportOk = false;
  } else if (mcp.isError) {
    transportOk = false;
  }
  if (!object(mcp) || !Array.isArray(mcp.content) || mcp.content.length !== 1
      || !object(mcp.content[0]) || mcp.content[0].type !== "text"
      || typeof mcp.content[0].text !== "string") {
    issues.push(issue("invalid_content", "content[0].text", "需要唯一的 MCP text 内容块。"));
    return { payload: null, issues, transport_ok: false };
  }
  try {
    const payload = JSON.parse(mcp.content[0].text);
    if (!object(payload)) throw new Error();
    return { payload, issues, transport_ok: transportOk && issues.length === 0 };
  } catch {
    issues.push(issue("invalid_business_json", "content[0].text", "业务结果不是 JSON 对象。"));
    return { payload: null, issues, transport_ok: false };
  }
}

/** Normalize only documented tool arguments, including the plugin's JSON array string. */
export function normalizeSnippetArguments(args) {
  if (!object(args)) throw new TypeError("需要本次调用的 original_code、candidate_code 和 test_cases 参数对象。");
  const allowed = new Set(["original_code", "candidate_code", "reported_error", "test_cases"]);
  if (Object.keys(args).some((key) => !allowed.has(key))) throw new TypeError("参数含有工具契约之外的字段。");
  for (const field of ["original_code", "candidate_code"]) {
    if (typeof args[field] !== "string" || !args[field].trim() || args[field].length > 12_000) throw new TypeError(`${field} 必须是 1–12000 字符的非空代码。`);
  }
  if (args.reported_error !== undefined && (typeof args.reported_error !== "string" || args.reported_error.length > 2_000)) throw new TypeError("reported_error 类型或长度无效。");
  let cases = args.test_cases === undefined ? [] : args.test_cases;
  if (typeof cases === "string") {
    try { cases = JSON.parse(cases); } catch { throw new TypeError("test_cases 必须是 JSON 用例数组，不能是说明文本。"); }
  }
  if (!Array.isArray(cases) || cases.length > MAX_CASES) throw new TypeError("test_cases 必须是至多 4 项的数组。");
  const submitted = cases.length;
  const effectiveCases = submitted ? cases : [{ name: "default", stdin: "" }];
  const normalized = effectiveCases.map((test, index) => {
    if (!object(test) || Object.keys(test).some((key) => !["name", "stdin", "expected_stdout"].includes(key))) throw new TypeError(`test_cases[${index}] 字段无效。`);
    for (const [field, maximum] of [["name", 200], ["stdin", 12_000], ["expected_stdout", 12_000]]) {
      if (own(test, field) && (typeof test[field] !== "string" || test[field].length > maximum)) throw new TypeError(`test_cases[${index}].${field} 类型或长度无效。`);
    }
    return {
      name: test.name || `case-${index + 1}`,
      stdin: test.stdin ?? "",
      expected_stdout: own(test, "expected_stdout") ? test.expected_stdout : null,
    };
  });
  return {
    original_code: args.original_code,
    candidate_code: args.candidate_code,
    reported_error: args.reported_error || null,
    submitted_case_count: submitted,
    test_cases: normalized,
  };
}

function validateExecution(execution, path, issues) {
  if (!object(execution)) {
    issues.push(issue("missing_execution", path, "缺少真实执行结果。"));
    return null;
  }
  const evidence = {
    ok: typeof execution.ok === "boolean" ? execution.ok : null,
    stdout: typeof execution.stdout === "string" ? execution.stdout : null,
    stderr: typeof execution.stderr === "string" ? execution.stderr : null,
    error_type: typeof execution.error_type === "string" ? execution.error_type : null,
    error_message: typeof execution.error_message === "string" ? execution.error_message : null,
  };
  for (const field of ["error_type", "error_message"]) {
    if (own(execution, field) && execution[field] !== null && typeof execution[field] !== "string") issues.push(issue("invalid_runtime_error_field", `${path}.${field}`, "异常字段只能是字符串或 null。"));
  }
  if (evidence.ok === null) issues.push(issue("invalid_execution_flag", `${path}.ok`, "运行状态须为布尔值。"));
  let complete = true;
  for (const stream of ["stdout", "stderr"]) {
    evidence[`${stream}_chars`] = execution[`${stream}_chars`] ?? null;
    evidence[`${stream}_complete`] = execution[`${stream}_complete`] ?? null;
    evidence[`${stream}_truncated`] = execution[`${stream}_truncated`] ?? null;
    if (evidence[stream] === null || !Number.isSafeInteger(execution[`${stream}_chars`]) || execution[`${stream}_chars`] < 0
        || typeof execution[`${stream}_complete`] !== "boolean" || typeof execution[`${stream}_truncated`] !== "boolean") {
      issues.push(issue("invalid_stream_metadata", `${path}.${stream}`, "输出及完整性字段缺失或类型错误。"));
      complete = false;
      continue;
    }
    // Pyodide counts Python code points; JS-generated worker failures count
    // UTF-16 units. Either exact representation is valid, never a larger count.
    const text = evidence[stream];
    const exactCount = execution[`${stream}_chars`] === text.length || execution[`${stream}_chars`] === Array.from(text).length;
    if (execution[`${stream}_complete`] !== true || execution[`${stream}_truncated`] !== false || !exactCount) complete = false;
    if (execution[`${stream}_complete`] === true && execution[`${stream}_truncated`] === false && !exactCount) {
      issues.push(issue("inconsistent_stream_length", `${path}.${stream}_chars`, "声明完整的输出长度与实际返回不符。"));
    }
  }
  if (evidence.ok === true && (evidence.error_type || evidence.error_message)) issues.push(issue("execution_contradiction", path, "运行成功却同时报告异常。"));
  if (evidence.ok === false && (!evidence.error_type || typeof execution.error_message !== "string")) issues.push(issue("missing_runtime_error", path, "运行失败缺少异常类型或异常消息。"));
  evidence.complete = complete;
  return evidence;
}

function compareFlag(payload, field, expected, path, issues) {
  if (typeof payload[field] !== "boolean") issues.push(issue("missing_boolean", `${path}${field}`, `${field} 必须明确返回布尔值。`));
  else if (expected !== null && payload[field] !== expected) issues.push(issue("state_contradiction", `${path}${field}`, `${field} 与完整执行证据不一致。`));
}

function finish(report, status) {
  report.status = status;
  report.fix_verified = status === "fix_verified";
  report.color = report.fix_verified ? "green" : ["missing_oracle", "already_correct", "unchanged_source"].includes(status) ? "amber" : "red";
  report.text = renderSnippetVerificationReport(report);
  return report;
}

/** Return structured predicates plus deterministic Chinese text. Never execute input. */
export function buildSnippetVerificationReport({ trusted_tool_response, invocation_arguments, current_arguments } = {}) {
  const report = {
    schema_version: SNIPPET_REPORT_SCHEMA,
    verification_level: "L1_SNIPPET_EXECUTION",
    status: "invalid_evidence",
    color: "red",
    fix_verified: false,
    tool_status: null,
    binding: { matched: false, invocation_arguments: null, current_arguments: null },
    facts: { source_changed: null, oracle_backed: null, before_failed: null, candidate_passed: null, runtime_repair_observed: null, complete_output: null },
    case_counts: { submitted: null, executed: 0 },
    test_results: [],
    issues: [],
    tool_error: null,
    boundary: SNIPPET_REPORT_BOUNDARY,
    binding_boundary: SNIPPET_BINDING_BOUNDARY,
    comparison_boundary: SNIPPET_COMPARISON_BOUNDARY,
    oracle_boundary: SNIPPET_ORACLE_BOUNDARY,
  };
  for (const [name, value] of [["invocation_arguments", invocation_arguments], ["current_arguments", current_arguments]]) {
    try { report.binding[name] = normalizeSnippetArguments(value); }
    catch (error) { report.issues.push(issue("invalid_arguments", name, error.message)); }
  }
  if (report.issues.length) return finish(report, "parameter_mismatch");
  report.binding.matched = JSON.stringify(report.binding.invocation_arguments) === JSON.stringify(report.binding.current_arguments);
  if (!report.binding.matched) {
    report.issues.push(issue("parameter_mismatch", "binding", "返回所属调用的代码或用例与当前参数不一致。"));
    return finish(report, "parameter_mismatch");
  }
  const args = report.binding.current_arguments;
  const parsed = parseTrustedSnippetResponse(trusted_tool_response);
  report.issues.push(...parsed.issues);
  const payload = parsed.payload;
  if (!payload) return finish(report, "invalid_evidence");
  report.tool_status = typeof payload.status === "string" ? payload.status : null;
  report.tool_error = typeof payload.error === "string" ? payload.error : null;
  if (!parsed.transport_ok) {
    report.issues.push(issue("tool_transport_error", "trusted_tool_response", "工具错误标志不允许认定通过。"));
    return finish(report, "tool_error");
  }
  if (payload.ok !== true) {
    report.issues.push(issue("business_not_ok", "ok", "业务工具未返回 ok=true。"));
    return finish(report, payload.status === "invalid_request" ? "invalid_request" : "tool_error");
  }
  for (const [field, expected] of [["mode", "single_snippet_rescue"], ["verification_level", "L1_SNIPPET_EXECUTION"], ["execution_backend", "pyodide_disposable_child_process"], ["worker_execution_strategy", "sequential_fresh_children"]]) {
    if (payload[field] !== expected) report.issues.push(issue("unsupported_contract", field, `缺少支持的 ${field} 契约。`));
  }
  if (!Number.isSafeInteger(payload.worker_timeout_ms) || payload.worker_timeout_ms < 500 || payload.worker_timeout_ms > 15_000) report.issues.push(issue("invalid_worker_timeout", "worker_timeout_ms", "缺少受限的 worker 超时配置。"));
  if (!Array.isArray(payload.test_results) || payload.test_results.length !== args.test_cases.length) {
    report.issues.push(issue("case_count_mismatch", "test_results", "实际返回的用例数与本次提交不符。"));
    return finish(report, "invalid_evidence");
  }
  report.case_counts = { submitted: args.submitted_case_count, executed: payload.test_results.length };
  if (!object(payload.case_counts) || payload.case_counts.submitted !== args.submitted_case_count || payload.case_counts.executed !== payload.test_results.length || payload.case_counts.maximum !== MAX_CASES) report.issues.push(issue("case_count_mismatch", "case_counts", "提交、执行或上限计数不符。"));
  if (payload.reported_error !== args.reported_error) report.issues.push(issue("reported_error_mismatch", "reported_error", "reported_error 与本次参数不符。"));
  for (let index = 0; index < args.test_cases.length; index += 1) {
    const expected = args.test_cases[index];
    const actual = payload.test_results[index];
    const path = `test_results[${index}].`;
    if (!object(actual)) {
      report.issues.push(issue("invalid_case", path, "用例结果不是对象。"));
      continue;
    }
    if (actual.name !== expected.name || actual.expected_stdout !== expected.expected_stdout) report.issues.push(issue("case_binding_mismatch", path, "用例名称或预期完整 stdout 与本次参数不符。"));
    const before = validateExecution(actual.before, `${path}before`, report.issues);
    const after = validateExecution(actual.after, `${path}after`, report.issues);
    const originalMatches = expected.expected_stdout === null ? true : before?.complete ? normalizeOutput(before.stdout) === normalizeOutput(expected.expected_stdout) : null;
    const outputMatches = expected.expected_stdout === null ? true : after?.complete ? normalizeOutput(after.stdout) === normalizeOutput(expected.expected_stdout) : null;
    const originalFailed = before?.ok === false ? true : before?.ok !== true || originalMatches === null ? null : !originalMatches;
    const candidatePassed = after?.ok === false ? false : after?.ok !== true || outputMatches === null ? null : outputMatches;
    for (const [field, expectedFlag] of [["original_failed", originalFailed], ["original_output_matches", originalMatches], ["candidate_passed", candidatePassed], ["output_matches", outputMatches]]) compareFlag(actual, field, expectedFlag, path, report.issues);
    report.test_results.push({ index: index + 1, name: expected.name, stdin: expected.stdin, expected_stdout: expected.expected_stdout, before, after, original_failed: originalFailed, original_output_matches: originalMatches, candidate_passed: candidatePassed, output_matches: outputMatches });
  }
  const cases = report.test_results;
  const beforeFailed = cases.some((item) => item.original_failed === true) ? true : cases.some((item) => item.original_failed === null) ? null : false;
  const candidatePassed = cases.some((item) => item.candidate_passed === false) ? false : cases.some((item) => item.candidate_passed === null) ? null : true;
  const sourceChanged = args.original_code !== args.candidate_code;
  const oracleBacked = args.test_cases.every((item) => item.expected_stdout !== null);
  const runtimeRepairObserved = sourceChanged && beforeFailed === true && candidatePassed === true;
  const fullEvidence = cases.length === args.test_cases.length && cases.every((item) => item.before?.complete && item.after?.complete);
  report.facts = { source_changed: sourceChanged, oracle_backed: oracleBacked, before_failed: beforeFailed, candidate_passed: candidatePassed, runtime_repair_observed: fullEvidence ? runtimeRepairObserved : null, complete_output: fullEvidence };
  const expectedFix = fullEvidence ? oracleBacked && runtimeRepairObserved : null;
  for (const [field, expected] of [["source_changed", sourceChanged], ["oracle_backed", oracleBacked], ["before_failed", beforeFailed], ["candidate_passed", candidatePassed], ["runtime_repair_observed", fullEvidence ? runtimeRepairObserved : null], ["fix_verified", expectedFix]]) compareFlag(payload, field, expected, "", report.issues);
  if (!["fix_verified", "candidate_runs", "candidate_failed"].includes(payload.status)) report.issues.push(issue("invalid_status", "status", "业务状态缺失或不受支持。"));
  if (fullEvidence) {
    const expectedStatus = expectedFix ? "fix_verified" : candidatePassed ? "candidate_runs" : "candidate_failed";
    if (payload.status !== expectedStatus) report.issues.push(issue("status_contradiction", "status", "业务状态与逐例证据不一致。"));
  }
  if (report.issues.length) return finish(report, "invalid_evidence");
  if (!fullEvidence) {
    report.issues.push(issue("incomplete_output", "test_results", "stdout 或 stderr 被截断或未完整返回，不能独立验收。"));
    return finish(report, "incomplete_output");
  }
  if (!candidatePassed) return finish(report, "candidate_failed");
  if (!oracleBacked) return finish(report, "missing_oracle");
  if (!beforeFailed) return finish(report, "already_correct");
  if (!sourceChanged) return finish(report, "unchanged_source");
  return finish(report, payload.fix_verified === true && expectedFix === true ? "fix_verified" : "invalid_evidence");
}

const SUMMARIES = {
  fix_verified: "修复已验证：修改前失败，修改后通过全部完整输出用例。",
  candidate_failed: "未验证修复：候选代码仍未通过全部用例。",
  missing_oracle: "未验证修复：缺少预期完整输出，只能检查运行情况。",
  already_correct: "未验证修复：原代码已通过所提交用例，未观察到失败到通过的修复。",
  unchanged_source: "未验证修复：原代码与候选代码相同。",
  parameter_mismatch: "未验证修复：工具调用参数与当前候选或用例未可靠绑定。",
  incomplete_output: "未验证修复：返回输出不完整，不能独立比较完整 stdout。",
  invalid_request: "未验证修复：工具拒绝请求，未取得可验收的执行证据。",
  tool_error: "未验证修复：工具或传输返回错误。",
  invalid_evidence: "未验证修复：必要字段缺失、参数不符或状态与证据矛盾。",
};

/** JSON-quoted streams preserve emptiness/newlines and cannot act as report prose. */
function renderSnippetVerificationReport(report) {
  const lines = [SUMMARIES[report.status] || SUMMARIES.invalid_evidence, `验收状态：${report.status}；fix_verified=${report.fix_verified === true && report.status === "fix_verified"}。`];
  for (const test of report.test_results || []) {
    lines.push(`用例 ${test.index} ${JSON.stringify(test.name)}；预期完整 stdout=${JSON.stringify(test.expected_stdout)}。`);
    for (const [label, execution] of [["修改前", test.before], ["修改后", test.after]]) {
      if (!execution) { lines.push(`${label}：无可用执行记录。`); continue; }
      lines.push(`${label}：ok=${execution.ok}；stdout=${JSON.stringify(execution.stdout)}；stderr=${JSON.stringify(execution.stderr)}；输出完整=${execution.complete}。`);
    }
    lines.push(`候选用例通过=${test.candidate_passed}；完整输出匹配=${test.output_matches}。`);
  }
  if (report.tool_error) lines.push(`工具错误原文：${JSON.stringify(report.tool_error)}。`);
  if (report.issues?.length) lines.push(`拒绝原因：${report.issues.map((item) => `${item.code}@${item.path}`).join("；")}。`);
  if (report.binding?.current_arguments) lines.push(`候选代码（仅字符串展示，不在报告节点执行）：${JSON.stringify(report.binding.current_arguments.candidate_code)}。`);
  lines.push(SNIPPET_COMPARISON_BOUNDARY, SNIPPET_REPORT_BOUNDARY, SNIPPET_BINDING_BOUNDARY, SNIPPET_ORACLE_BOUNDARY);
  return lines.join("\n");
}
