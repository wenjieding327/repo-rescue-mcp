"""Offline standard-library L1 report gate for an XFYun Python code node.

Paste this whole file into the independent report node. Bind result_json directly
from the plugin, and original_code/candidate_code/test_cases from the SAME call's
node variables. main() only returns data; it never executes candidate code, reads
credentials, accesses files/network, or parses REASONING_CONTENT/model prose.

TRUST BOUNDARY: source authentication and same-invocation source/stdin association
belong to the workflow. The backend does not echo code or stdin. This function
cannot authenticate a forged response or validate independently authored oracles.
It checks the direct MCP result_json -> content[0].text -> business JSON contract.
"""

import json

BOUNDARY = "仅验证本次提交的 Python 片段和用例（L1）；不证明完整仓库、项目或论文复现成功。"
BINDING_BOUNDARY = "调用方须保证工具来源可信，并把返回与同一次调用的参数绑定；此报告不是签名回执。"
ORACLE_BOUNDARY = "预期输出须来自用户或独立规格；此节点只检查其存在与绑定，不证明 oracle 独立性。"
COMPARISON_BOUNDARY = "比较整段 stdout：CRLF 转 LF，再去除末尾空白（与工具 trimEnd 一致）；不抽取单行，空输出与纯末尾空白可能等价。"
# ECMAScript WhiteSpace + LineTerminator, not Python's broader generic rstrip().
JS_TRIM_END = "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
SUMMARIES = {
    "fix_verified": "修复已验证：修改前失败，修改后通过全部完整输出用例。",
    "candidate_failed": "未验证修复：候选代码仍未通过全部用例。",
    "missing_oracle": "未验证修复：缺少预期完整输出，只能检查运行情况。",
    "already_correct": "未验证修复：原代码已通过所提交用例，未观察到失败到通过的修复。",
    "unchanged_source": "未验证修复：原代码与候选代码相同。",
    "parameter_mismatch": "未验证修复：参数或用例绑定无效。",
    "incomplete_output": "未验证修复：返回输出不完整，不能独立比较完整 stdout。",
    "invalid_request": "未验证修复：工具拒绝请求，未取得可验收的执行证据。",
    "tool_error": "未验证修复：工具返回错误。",
    "invalid_evidence": "未验证修复：必要字段缺失、参数不符或状态与证据矛盾。",
}


def _js_len(text):
    return len(text.encode("utf-16-le", errors="surrogatepass")) // 2


def _normalize_output(text):
    return text.replace("\r\n", "\n").rstrip(JS_TRIM_END)


def _quote(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _arguments(original_code, candidate_code, test_cases):
    for name, text in (("original_code", original_code), ("candidate_code", candidate_code)):
        if not isinstance(text, str) or not text.strip() or _js_len(text) > 12000:
            raise ValueError(name + " 类型、空值或长度无效")
    cases = json.loads(test_cases) if isinstance(test_cases, str) else test_cases
    if cases is None:
        cases = []
    if not isinstance(cases, list) or len(cases) > 4:
        raise ValueError("test_cases 必须是至多 4 项的数组")
    submitted = len(cases)
    if not cases:
        cases = [{"name": "default", "stdin": ""}]
    normalized = []
    for index, case in enumerate(cases):
        if not isinstance(case, dict) or set(case) - {"name", "stdin", "expected_stdout"}:
            raise ValueError("test_cases 字段无效")
        for field, maximum in (("name", 200), ("stdin", 12000), ("expected_stdout", 12000)):
            if field in case and (not isinstance(case[field], str) or _js_len(case[field]) > maximum):
                raise ValueError("test_cases." + field + " 类型或长度无效")
        normalized.append({"name": case.get("name") or "case-" + str(index + 1), "stdin": case.get("stdin", ""), "expected_stdout": case.get("expected_stdout")})
    return submitted, normalized


def _flag(data, key, expected, issues, prefix=""):
    if type(data.get(key)) is not bool:
        issues.append("missing_boolean@" + prefix + key)
    elif expected is not None and data[key] is not expected:
        issues.append("state_contradiction@" + prefix + key)


def _execution(value, prefix, issues):
    if not isinstance(value, dict):
        issues.append("missing_execution@" + prefix)
        return None
    evidence = {
        "ok": value.get("ok") if type(value.get("ok")) is bool else None,
        "stdout": value.get("stdout") if isinstance(value.get("stdout"), str) else None,
        "stderr": value.get("stderr") if isinstance(value.get("stderr"), str) else None,
        "error_type": value.get("error_type") if isinstance(value.get("error_type"), str) else None,
        "error_message": value.get("error_message") if isinstance(value.get("error_message"), str) else None,
    }
    for field in ("error_type", "error_message"):
        if field in value and value[field] is not None and not isinstance(value[field], str):
            issues.append("invalid_runtime_error_field@" + prefix + "." + field)
    if evidence["ok"] is None:
        issues.append("invalid_execution_flag@" + prefix + ".ok")
    complete = True
    for stream in ("stdout", "stderr"):
        for suffix in ("chars", "complete", "truncated"):
            evidence[stream + "_" + suffix] = value.get(stream + "_" + suffix)
        count = value.get(stream + "_chars")
        metadata_valid = evidence[stream] is not None and type(count) is int and 0 <= count <= 9007199254740991 and type(value.get(stream + "_complete")) is bool and type(value.get(stream + "_truncated")) is bool
        if not metadata_valid:
            issues.append("invalid_stream_metadata@" + prefix + "." + stream)
            complete = False
            continue
        exact = count in (len(evidence[stream]), _js_len(evidence[stream]))
        if value[stream + "_complete"] is not True or value[stream + "_truncated"] is not False or not exact:
            complete = False
        if value[stream + "_complete"] is True and value[stream + "_truncated"] is False and not exact:
            issues.append("inconsistent_stream_length@" + prefix + "." + stream)
    if evidence["ok"] is True and (evidence["error_type"] or evidence["error_message"]):
        issues.append("execution_contradiction@" + prefix)
    if evidence["ok"] is False and (not evidence["error_type"] or not isinstance(value.get("error_message"), str)):
        issues.append("missing_runtime_error@" + prefix)
    evidence["complete"] = complete
    return evidence


def _finish(state, status):
    verified = status == "fix_verified"
    lines = [SUMMARIES.get(status, SUMMARIES["invalid_evidence"]), "验收状态：" + status + "；fix_verified=" + str(verified).lower() + "。"]
    for case in state["test_results"]:
        lines.append("用例 " + str(case["index"]) + " " + _quote(case["name"]) + "；预期完整 stdout=" + _quote(case["expected_stdout"]) + "。")
        for label, execution in (("修改前", case["before"]), ("修改后", case["after"])):
            if execution is None:
                lines.append(label + "：无可用执行记录。")
            else:
                lines.append(label + "：ok=" + _quote(execution["ok"]) + "；stdout=" + _quote(execution["stdout"]) + "；stderr=" + _quote(execution["stderr"]) + "；输出完整=" + _quote(execution["complete"]) + "。")
        lines.append("候选用例通过=" + _quote(case["candidate_passed"]) + "；完整输出匹配=" + _quote(case["output_matches"]) + "。")
    if state.get("tool_error"):
        lines.append("工具错误原文：" + _quote(state["tool_error"]) + "。")
    if state["issues"]:
        lines.append("拒绝原因：" + "；".join(state["issues"]) + "。")
    if isinstance(state["candidate_code"], str):
        lines.append("候选代码（仅字符串展示，不在报告节点执行）：" + _quote(state["candidate_code"]) + "。")
    lines.extend((COMPARISON_BOUNDARY, BOUNDARY, BINDING_BOUNDARY, ORACLE_BOUNDARY))
    return {"report": "\n".join(lines), "status": status, "retry_needed": status == "candidate_failed"}


def main(result_json, original_code, candidate_code, test_cases):
    """Direct plugin result_json + same-call parameters -> fixed report outputs.

    retry_needed is a real Boolean, true only for a coherent candidate failure.
    It is NOT an authorization for unlimited retry; workflow bounds are external.
    Missing oracle, unsafe source association, broken evidence and transport errors
    cannot be repaired by silently generating new expected outputs.
    """
    state = {"candidate_code": candidate_code, "issues": [], "test_results": [], "tool_error": None}
    issues = state["issues"]
    try:
        submitted, cases = _arguments(original_code, candidate_code, test_cases)
    except (TypeError, ValueError, UnicodeError):
        issues.append("invalid_arguments@same_invocation")
        return _finish(state, "parameter_mismatch")
    try:
        if not isinstance(result_json, str):
            raise ValueError()
        mcp = json.loads(result_json)
        if not isinstance(mcp, dict) or type(mcp.get("isError")) is not bool:
            raise ValueError()
        content = mcp.get("content")
        if not isinstance(content, list) or len(content) != 1 or not isinstance(content[0], dict) or content[0].get("type") != "text" or not isinstance(content[0].get("text"), str):
            raise ValueError()
        payload = json.loads(content[0]["text"])
        if not isinstance(payload, dict):
            raise ValueError()
    except (TypeError, ValueError):
        issues.append("invalid_direct_mcp_json@result_json")
        return _finish(state, "invalid_evidence")
    if mcp["isError"] is True:
        issues.append("tool_transport_error@isError")
        return _finish(state, "tool_error")
    state["tool_error"] = payload.get("error") if isinstance(payload.get("error"), str) else None
    if payload.get("ok") is not True:
        issues.append("business_not_ok@ok")
        return _finish(state, "invalid_request" if payload.get("status") == "invalid_request" else "tool_error")
    for field, expected in (("mode", "single_snippet_rescue"), ("verification_level", "L1_SNIPPET_EXECUTION"), ("execution_backend", "pyodide_disposable_child_process"), ("worker_execution_strategy", "sequential_fresh_children")):
        if payload.get(field) != expected:
            issues.append("unsupported_contract@" + field)
    if type(payload.get("worker_timeout_ms")) is not int or not 500 <= payload["worker_timeout_ms"] <= 15000:
        issues.append("invalid_worker_timeout@worker_timeout_ms")
    results = payload.get("test_results")
    if not isinstance(results, list) or len(results) != len(cases):
        issues.append("case_count_mismatch@test_results")
        return _finish(state, "invalid_evidence")
    counts = payload.get("case_counts")
    if not isinstance(counts, dict) or any(type(counts.get(key)) is not int or counts[key] != expected for key, expected in (("submitted", submitted), ("executed", len(results)), ("maximum", 4))):
        issues.append("case_count_mismatch@case_counts")
    for index, (expected, actual) in enumerate(zip(cases, results)):
        path = "test_results[" + str(index) + "]."
        if not isinstance(actual, dict):
            issues.append("invalid_case@" + path)
            continue
        if actual.get("name") != expected["name"] or "expected_stdout" not in actual or actual["expected_stdout"] != expected["expected_stdout"]:
            issues.append("case_binding_mismatch@" + path)
        before = _execution(actual.get("before"), path + "before", issues)
        after = _execution(actual.get("after"), path + "after", issues)
        oracle = expected["expected_stdout"]
        original_matches = True if oracle is None else _normalize_output(before["stdout"]) == _normalize_output(oracle) if before and before["complete"] else None
        output_matches = True if oracle is None else _normalize_output(after["stdout"]) == _normalize_output(oracle) if after and after["complete"] else None
        original_failed = True if before and before["ok"] is False else not original_matches if before and before["ok"] is True and original_matches is not None else None
        candidate_passed = False if after and after["ok"] is False else output_matches if after and after["ok"] is True else None
        for field, expected_flag in (("original_failed", original_failed), ("original_output_matches", original_matches), ("candidate_passed", candidate_passed), ("output_matches", output_matches)):
            _flag(actual, field, expected_flag, issues, path)
        state["test_results"].append({"index": index + 1, "name": expected["name"], "stdin": expected["stdin"], "expected_stdout": oracle, "before": before, "after": after, "original_failed": original_failed, "candidate_passed": candidate_passed, "output_matches": output_matches})
    evidence = state["test_results"]
    before_failed = True if any(case["original_failed"] is True for case in evidence) else None if any(case["original_failed"] is None for case in evidence) else False
    candidate_passed = False if any(case["candidate_passed"] is False for case in evidence) else None if any(case["candidate_passed"] is None for case in evidence) else True
    source_changed = original_code != candidate_code
    oracle_backed = all(case["expected_stdout"] is not None for case in cases)
    complete = len(evidence) == len(cases) and all(case["before"] and case["before"]["complete"] and case["after"] and case["after"]["complete"] for case in evidence)
    runtime_repair = source_changed and before_failed is True and candidate_passed is True
    expected_fix = oracle_backed and runtime_repair if complete else None
    for field, expected in (("source_changed", source_changed), ("oracle_backed", oracle_backed), ("before_failed", before_failed), ("candidate_passed", candidate_passed), ("runtime_repair_observed", runtime_repair if complete else None), ("fix_verified", expected_fix)):
        _flag(payload, field, expected, issues)
    if payload.get("status") not in ("fix_verified", "candidate_runs", "candidate_failed"):
        issues.append("invalid_status@status")
    if complete:
        expected_status = "fix_verified" if expected_fix else "candidate_runs" if candidate_passed else "candidate_failed"
        if payload.get("status") != expected_status:
            issues.append("status_contradiction@status")
    if issues:
        return _finish(state, "invalid_evidence")
    if not complete:
        issues.append("incomplete_output@test_results")
        return _finish(state, "incomplete_output")
    if not candidate_passed:
        return _finish(state, "candidate_failed")
    if not oracle_backed:
        return _finish(state, "missing_oracle")
    if not before_failed:
        return _finish(state, "already_correct")
    if not source_changed:
        return _finish(state, "unchanged_source")
    return _finish(state, "fix_verified" if payload.get("fix_verified") is True and expected_fix is True else "invalid_evidence")
