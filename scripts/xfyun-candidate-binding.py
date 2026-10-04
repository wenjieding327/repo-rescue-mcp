"""Independent, offline XFYun candidate-binding code node (standard library).

main(context, agent_output) freezes original code, stdin, oracles, repository and
request time from the trusted router context. Agent output is one strict JSON
object with exactly ONE candidate_code, job_id or advice key (optional one json
fence), or one exact frozen-route envelope containing its single candidate field.
No model-supplied original/oracle/status/receipt is accepted. This module
never executes/evaluates candidate code, performs I/O or authenticates a job ID.

Source association remains a workflow responsibility: context must be a direct
router reference, not Agent text. A syntactic print-call COUNT guard discourages
deleting/adding print sites but does not prove semantics, detect every alias, or
prevent hardcoding. Frozen independent oracles and downstream execution remain
authoritative. Original syntax errors skip only that guard, visibly disclosed.
"""

import ast
from datetime import datetime
import json
import re

MAX_CODE_CHARS = 12000
MAX_AGENT_CHARS = 100000
MAX_CONTEXT_CHARS = 200000
MAX_ADVICE_CHARS = 4000
_JSON_FENCE = re.compile(r"\A[ \t\r\n]*```json[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t\r\n]*\Z", re.IGNORECASE)
_JOB_ID = re.compile(r"[A-Za-z0-9_-]{43}\Z", re.ASCII)
_REPO = re.compile(r"https://github\.com/[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?/[A-Za-z0-9_.-]{1,100}\Z", re.ASCII)


def _length(value):
    return len(value.encode("utf-16-le", errors="surrogatepass")) // 2


def _json(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("重复 JSON 字段不允许")
        result[key] = value
    return result


def _load(text):
    return json.loads(text, object_pairs_hook=_unique_object)


def _string(value, maximum, nonempty=False):
    if not isinstance(value, str) or _length(value) > maximum or "\x00" in value:
        raise ValueError("字符串类型、长度或空字符无效")
    value.encode("utf-8")
    if nonempty and not value.strip():
        raise ValueError("内容不能为空")
    return value


def _frozen_context(context):
    if isinstance(context, str):
        context = _load(_string(context, MAX_CONTEXT_CHARS, True))
    if not isinstance(context, dict):
        raise ValueError("冻结上下文不是 JSON 对象")
    route = context.get("route")
    if route not in {"snippet", "github", "advice"}:
        raise ValueError("冻结路由无效")
    original = _string(context.get("original_code"), MAX_CODE_CHARS, route == "snippet")
    repository = _string(context.get("repo_url"), 500)
    started = _string(context.get("request_started_at"), 40, True)
    parsed_time = datetime.fromisoformat(started[:-1] + "+00:00" if started.endswith("Z") else started)
    if parsed_time.tzinfo is None or parsed_time.utcoffset() is None:
        raise ValueError("冻结请求时间缺少时区")
    cases = context.get("test_cases")
    if isinstance(cases, str):
        cases = _load(_string(cases, MAX_CONTEXT_CHARS))
    if not isinstance(cases, list) or len(cases) > 4:
        raise ValueError("冻结用例必须是至多四项的数组")
    frozen_cases = []
    for case in cases:
        if not isinstance(case, dict) or set(case) - {"name", "stdin", "expected_stdout"}:
            raise ValueError("冻结用例字段无效")
        frozen = {}
        for field, maximum in (("name", 200), ("stdin", 12000), ("expected_stdout", 12000)):
            if field in case:
                frozen[field] = _string(case[field], maximum)
        frozen_cases.append(frozen)
    if route == "snippet" and repository:
        raise ValueError("片段上下文混入仓库路由")
    if route == "github":
        if original or frozen_cases or not _REPO.fullmatch(repository) or repository.rsplit("/", 1)[-1] in {".", ".."}:
            raise ValueError("仓库冻结上下文不匹配")
    return route, original, frozen_cases, repository, started


def _agent_object(agent_output, route):
    text = _string(agent_output, MAX_AGENT_CHARS, True)
    fence = _JSON_FENCE.fullmatch(text)
    if fence:
        text = fence.group(1)
    value = _load(text)
    # One exact route envelope is formatting only, never model evidence.
    # Do not recursively unwrap, decode strings, or accept cross-route aliases.
    if isinstance(value, dict) and set(value) == {route} and route in {"snippet", "github"}:
        inner = value[route]
        expected = "candidate_code" if route == "snippet" else "job_id"
        if not isinstance(inner, dict) or set(inner) != {expected}:
            raise ValueError("路由包装必须只包含对应的候选字段")
        value = inner
    if not isinstance(value, dict) or len(value) != 1 or set(value) - {"candidate_code", "job_id", "advice"}:
        raise ValueError("Agent 必须只返回候选代码、任务标识或建议之一")
    return value


def _print_calls(tree):
    return sum(1 for node in ast.walk(tree) if isinstance(node, ast.Call) and (
        isinstance(node.func, ast.Name) and node.func.id == "print"
        or isinstance(node.func, ast.Attribute) and node.func.attr == "print"
    ))


def main(context, agent_output):
    """Return frozen pipeline fields; any malformed/mismatched output -> advice."""
    result = {"route": "advice", "original_code": "", "candidate_code": "", "test_cases": "[]", "repo_url": "", "job_id": "", "request_started_at": "", "binding": "{}", "report": "未执行、未验证。"}
    try:
        route, original, cases, repository, started = _frozen_context(context)
        result.update(original_code=original, test_cases=_json(cases), repo_url=repository, request_started_at=started)
        value = _agent_object(agent_output, route)
        if "advice" in value:
            advice = _string(value["advice"], MAX_ADVICE_CHARS, True)
            result["report"] = "未执行、未验证。模型建议原文（不构成运行事实或通过证据）：" + _json(advice) + "。"
            return result
        if route == "snippet" and "candidate_code" in value:
            candidate = _string(value["candidate_code"], MAX_CODE_CHARS, True)
            candidate_tree = ast.parse(candidate, filename="<candidate-code>")
            try:
                original_tree = ast.parse(original, filename="<original-code>")
            except SyntaxError:
                guard = "原代码有语法错误，已跳过 print 调用数量检查；必须由独立工具执行验收。"
            else:
                if _print_calls(original_tree) != _print_calls(candidate_tree):
                    raise ValueError("候选增加或删除了 print 调用，不能改变用户程序输出调用数量")
                guard = "print 调用数量未增减；此静态检查不证明语义正确，也不能防止全部硬编码。"
            binding = {"original_code": original, "candidate_code": candidate, "test_cases": cases}
            result.update(route="snippet", candidate_code=candidate, binding=_json(binding), report="候选已绑定冻结原代码与用例；尚未执行、未验证。" + guard)
            return result
        if route == "github" and "job_id" in value:
            job_id = _string(value["job_id"], 43, True)
            if not _JOB_ID.fullmatch(job_id):
                raise ValueError("任务标识必须是 43 个 URL-safe 字符")
            result.update(route="github", job_id=job_id, binding=_json({"repo_url": repository, "job_id": job_id, "request_started_at": started}), report="仅收到待查询的任务标识；未确认任务归属、状态或修复成功，必须由独立后端查询与验收。")
            return result
        raise ValueError("Agent 输出与冻结路由不匹配")
    except (TypeError, ValueError, SyntaxError, UnicodeError, RecursionError, MemoryError) as error:
        result["report"] = "未执行、未验证：候选绑定已拒绝。请返回单个严格 JSON 并保留冻结规格。原因：" + str(error)[:250] + "。"
        return result
