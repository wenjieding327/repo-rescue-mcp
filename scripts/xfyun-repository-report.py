"""Pure, offline report gate for the actual rescue_poll MCP result_json.

main(result_json, repo_url, job_id, request_started_at) returns report/status.
The caller MUST obtain result_json directly from rescue_poll, associate it with
that exact invocation, and supply repository/job/start time from trusted request
state, not Agent prose or Agent-created JSON. This code authenticates neither
the plugin nor receipt signatures. It executes no repository code or network.

Actual job snapshots expose operation, not kind, and have no public job creation
or update timestamps. Only a terminal verification's repair.started_at and
completed_at can establish freshness. Preparation and queued jobs never verify.
Only the presently supported public Docker pytest evidence can become green.
"""
import hashlib
import json
import math
import re
from datetime import datetime, timedelta, timezone
from urllib.parse import urlsplit

BOUNDARY = "只有验收通过时，才证明本轮固定仓库提交及同一 pytest 测试范围的失败到通过；失败不构成修复证明；不证明任意仓库、完整项目或论文复现。"
TRUST_BOUNDARY = "依据独立 rescue_poll 原始返回；调用方负责可信来源和本次调用绑定，本报告不验签、不生成收据。"
LOG_BOUNDARY = "下列 stdout/stderr 是后端保存的脱敏日志；显示时隐藏 capability、凭据及日志链接，不推测未执行的输出。"
RECEIPT_HOST = "reporescue-mcp-production.up.railway.app"
BRIDGE_REPOSITORY = "wenjieding327/repo-rescue-mcp"
JOB_ID = re.compile(r"[A-Za-z0-9_-]{43}\Z")
SHA1 = re.compile(r"[0-9a-f]{40}\Z")
SHA256 = re.compile(r"[0-9a-f]{64}\Z")
RECEIPT_PATH = re.compile(r"/r/v1\.([1-9][0-9]{0,15})\.([1-9][0-9]{0,15})\.[1-9][0-9]{9}\.[A-Za-z0-9_-]{32}/?\Z")
OPERATIONS = ("prepare_github_repair", "verify_github_patch")
PENDING = ("dispatching", "dispatch_unknown", "queued", "running", "collecting_artifact")
SUMMARIES = {
    "verified_repair": "已验证仓库修复：本轮原始测试失败，候选以同一命令通过且测试范围未缩减。",
    "already_passing": "未发生已验证修复：后端报告原仓库已经通过，不能计为修复成功。",
    "preparation_ready": "准备阶段已返回，尚无本轮候选复测证据，不能宣称修复成功。",
    "preparation_unverified": "准备阶段没有可继续修复的完整条件，不能宣称修复成功。",
    "queued": "作业尚未终止：仍在派发、排队、运行或收集产物，不能宣称修复成功。",
    "repository_not_allowed": "仓库未获执行白名单授权；这是安全拒绝，不是修复成功。",
    "unknown_job": "后端无法找到当前作业或作业已过期；未取得本轮成功证据。",
    "failed": "本轮作业或候选失败，不能宣称修复成功。",
    "repair_unverified": "后端未认定已验证修复；运行或测试通过不足以替代修复证据。",
    "parameter_mismatch": "未验证修复：当前入口参数、仓库或作业绑定不可靠。",
    "stale_evidence": "未验证修复：返回的运行时间不属于本轮请求或时间记录不一致。",
    "missing_freshness_evidence": "未验证修复：缺少终态修复的真实起止时间。",
    "invalid_evidence": "未验证修复：必要字段缺失、类型错误或证据互相矛盾。",
    "tool_error": "未验证修复：工具或传输返回错误。",
}


def _now():
    return datetime.now(timezone.utc)


def _duplicate_free(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON key")
        result[key] = value
    return result


def _load(text):
    if not isinstance(text, str) or len(text) > 4_000_000:
        raise ValueError("not bounded JSON text")
    def reject_constant(_):
        raise ValueError("non-finite JSON number")
    value = json.loads(text, object_pairs_hook=_duplicate_free, parse_constant=reject_constant)
    # JSON exponents may overflow a float without using the Infinity token;
    # escaped lone surrogates must not reach artifact encoding or report output.
    json.dumps(value, ensure_ascii=False, allow_nan=False).encode("utf-8")
    return value


def _time(value):
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})", value):
        raise ValueError("timezone-bearing ISO timestamp required")
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("timezone required")
    return parsed.astimezone(timezone.utc)


def _repository(value):
    if not isinstance(value, str) or len(value) > 300:
        raise ValueError("canonical GitHub URL required")
    parsed = urlsplit(value)
    if parsed.scheme != "https" or parsed.netloc != "github.com" or parsed.query or parsed.fragment:
        raise ValueError("canonical GitHub URL required")
    match = re.fullmatch(r"/([A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9][A-Za-z0-9_.-]*)", parsed.path)
    if not match or match[1].endswith(".git"):
        raise ValueError("canonical GitHub URL required")
    return match[1]


def _redact(text, job_id):
    text = text.replace(job_id, "[作业 capability 已隐藏]") if isinstance(job_id, str) and job_id else text
    text = re.sub(r"(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])", "[capability 已隐藏]", text)
    text = re.sub(r"https?://[^\s\"'<>]+", "[日志链接已隐藏]", text, flags=re.I)
    text = re.sub(r"(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|Bearer\s+\S+)", "[凭据已隐藏]", text, flags=re.I)
    return re.sub(r"(?i)(api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+", r"\1=[凭据已隐藏]", text)


def _quote(value, job_id):
    if isinstance(value, str):
        value = _redact(value, job_id)
    elif isinstance(value, list):
        return "[" + ", ".join(_quote(item, job_id) for item in value) + "]"
    elif isinstance(value, dict):
        return "{" + ", ".join(_quote(key, job_id) + ": " + _quote(value[key], job_id) for key in sorted(value)) + "}"
    return json.dumps(value, ensure_ascii=False, allow_nan=False, sort_keys=True)


def _finish(state, status):
    lines = [SUMMARIES.get(status, SUMMARIES["invalid_evidence"]), "验收状态：" + status + "；verified_repair=" + str(status == "verified_repair").lower() + "。"]
    lines.extend(state["facts"])
    if state["issues"]:
        lines.append("拒绝原因：" + "；".join(state["issues"]) + "。")
    if status == "verified_repair":
        lines.append("下载后端原始补丁和证据报告：" + state["receipt"] if state.get("receipt") else "原始文件交付：后端未提供允许公开的收据链接；本报告不拼接或伪造链接。")
    lines.extend((BOUNDARY, TRUST_BOUNDARY, LOG_BOUNDARY))
    return {"report": "\n".join(lines), "status": status}


def _number(value):
    return type(value) in (int, float) and 0 <= value <= 86_400 and (type(value) is int or math.isfinite(value))


def _execution(value, path, issues, install=False):
    if not isinstance(value, dict):
        issues.append("missing_execution@" + path)
        return None
    if type(value.get("exit_code")) is not int or type(value.get("timed_out")) is not bool or not _number(value.get("duration_seconds")):
        issues.append("invalid_execution_fields@" + path)
    for field in ("stdout", "stderr"):
        stream = value.get(field)
        if not isinstance(stream, str):
            issues.append("missing_stream@" + path + "." + field)
        elif "[output truncated after " in stream or len(stream) > 65_536:
            issues.append("incomplete_output@" + path + "." + field)
        for optional, required in ((field + "_complete", True), (field + "_truncated", False)):
            if optional in value and value[optional] is not required:
                issues.append("incomplete_output@" + path + "." + optional)
    if value.get("timed_out") is not False:
        issues.append("execution_timeout@" + path)
    if install and value.get("exit_code") != 0:
        issues.append("install_failed@" + path)
    return value


def _phase(value, path, verified, issues):
    if not isinstance(value, dict):
        issues.append("missing_phase@" + path)
        return None
    for field, expected in (("backend", "docker"), ("verified", verified), ("status", "verified" if verified else "verification_failed"), ("verification_scope", "pytest_suite"), ("repair_evidence_eligible", True)):
        if field not in value or type(value[field]) is not type(expected) or value[field] != expected:
            issues.append("phase_contradiction@" + path + "." + field)
    if value.get("command") != "python -m pytest -q":
        issues.append("unsupported_command@" + path + ".command")
    _execution(value.get("install"), path + ".install", issues, install=True)
    execution = _execution(value.get("execution"), path + ".execution", issues)
    if execution is None:
        return None
    exit_code = execution.get("exit_code")
    if type(exit_code) is not int or (exit_code != 0 if verified else exit_code == 0):
        issues.append("exit_contradiction@" + path + ".execution.exit_code")
    counts = execution.get("pytest_attestation")
    if not isinstance(counts, dict) or counts.get("completed") is not True:
        issues.append("missing_pytest_attestation@" + path)
        return None
    keys = ("collected", "passed", "failed", "skipped", "errors", "runner_exit_code")
    if any(type(counts.get(key)) is not int or counts[key] < 0 for key in keys):
        issues.append("invalid_pytest_counts@" + path)
        return None
    if counts["runner_exit_code"] != exit_code or counts["collected"] < 1 or sum(counts[key] for key in ("passed", "failed", "skipped", "errors")) != counts["collected"]:
        issues.append("pytest_counts_contradiction@" + path)
    if verified and (counts["passed"] < 1 or counts["failed"] != 0 or counts["errors"] != 0):
        issues.append("pytest_not_passed@" + path)
    if not verified and counts["failed"] + counts["errors"] < 1:
        issues.append("baseline_failure_not_observed@" + path)
    return counts


def _safe_receipt(value, actions):
    if not isinstance(value, str):
        return False
    try:
        parsed = urlsplit(value)
    except ValueError:
        return False
    match = RECEIPT_PATH.fullmatch(parsed.path)
    return parsed.scheme == "https" and parsed.netloc == RECEIPT_HOST and not parsed.query and not parsed.fragment and match is not None and isinstance(actions, dict) and match[1] == str(actions.get("workflow_run_id")) and match[2] == str(actions.get("artifact_id"))


def _artifact(repair, actions, issues):
    if not isinstance(actions, dict):
        issues.append("missing_actions_artifact@github_actions")
        return
    if actions.get("repository") != BRIDGE_REPOSITORY or any(type(actions.get(key)) is not int or actions[key] <= 0 for key in ("workflow_run_id", "artifact_id")) or not isinstance(actions.get("head_sha"), str) or not SHA1.fullmatch(actions["head_sha"]):
        issues.append("invalid_actions_identity@github_actions")
    if not isinstance(actions.get("artifact_name"), str) or not re.fullmatch(r"repo-rescue-[A-Za-z0-9_-]{43}", actions["artifact_name"]) or not isinstance(actions.get("artifact_digest"), str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", actions["artifact_digest"]):
        issues.append("invalid_actions_artifact@github_actions")
    contents, files = actions.get("artifact_contents"), actions.get("files")
    if not isinstance(contents, dict) or not isinstance(files, dict):
        issues.append("missing_original_artifacts@github_actions")
        return
    for field, name in (("patch", "repair.patch"), ("evidence", "evidence.json"), ("report", "report.md")):
        raw, metadata = contents.get(field), files.get(name)
        if not isinstance(raw, str) or not raw or not isinstance(metadata, dict):
            issues.append("missing_original_artifact@" + name)
            continue
        encoded = raw.encode("utf-8")
        if type(metadata.get("bytes")) is not int or metadata["bytes"] != len(encoded) or metadata.get("sha256") != hashlib.sha256(encoded).hexdigest():
            issues.append("artifact_digest_mismatch@" + name)
    patch = contents.get("patch")
    if isinstance(patch, str):
        if hashlib.sha256(patch.encode("utf-8")).hexdigest() != repair.get("patch_sha256"):
            issues.append("patch_digest_mismatch@repair")
        paths = re.findall(r"^(?:--- a/|\+\+\+ b/)([^\r\n]+)$", patch, re.M)
        if not paths or set(paths) != set(repair.get("changed_files", [])):
            issues.append("patch_paths_mismatch@changed_files")
    try:
        evidence = _load(contents.get("evidence"))
        if not isinstance(evidence, dict):
            raise ValueError()
        original = {key: value for key, value in evidence.items() if key != "artifacts"}
        returned = {key: value for key, value in repair.items() if key != "artifacts"}
        if json.dumps(original, sort_keys=True, allow_nan=False) != json.dumps(returned, sort_keys=True, allow_nan=False):
            issues.append("original_evidence_mismatch@repair")
    except (TypeError, ValueError, RecursionError):
        issues.append("invalid_original_evidence@evidence.json")
    if not isinstance(contents.get("report"), str) or not isinstance(repair.get("run_id"), str) or repair["run_id"] not in contents["report"]:
        issues.append("original_report_mismatch@report.md")


def main(result_json, repo_url, job_id, request_started_at):
    """Return fixed report/status; no Agent prose, dispatch, I/O, or credentials."""
    state = {"issues": [], "facts": [], "receipt": None}
    issues = state["issues"]
    try:
        slug = _repository(repo_url)
        if not isinstance(job_id, str) or not JOB_ID.fullmatch(job_id):
            raise ValueError()
        request_start = _time(request_started_at)
        now = _now()
        if request_start > now:
            raise ValueError()
    except (TypeError, ValueError, OverflowError):
        issues.append("invalid_trusted_entry_arguments")
        return _finish(state, "parameter_mismatch")
    try:
        mcp = _load(result_json)
        if not isinstance(mcp, dict) or type(mcp.get("isError")) is not bool:
            raise ValueError()
        content = mcp.get("content")
        if not isinstance(content, list) or len(content) != 1 or not isinstance(content[0], dict) or content[0].get("type") != "text":
            raise ValueError()
        payload = _load(content[0].get("text"))
        if not isinstance(payload, dict) or type(payload.get("ok")) is not bool:
            raise ValueError()
    except (TypeError, ValueError, RecursionError):
        issues.append("invalid_direct_mcp_json@result_json")
        return _finish(state, "invalid_evidence")
    if mcp["isError"]:
        return _finish(state, "tool_error")
    if payload["ok"] is not True:
        return _finish(state, payload.get("status") if payload.get("status") in ("unknown_job", "repository_not_allowed") else "failed")
    job = payload.get("job")
    if not isinstance(job, dict) or job.get("job_id") != job_id:
        issues.append("job_binding_mismatch@job.job_id")
        return _finish(state, "parameter_mismatch")
    operation, status, terminal = job.get("operation"), job.get("status"), job.get("terminal")
    if operation not in OPERATIONS or type(terminal) is not bool or not isinstance(status, str):
        issues.append("invalid_job_contract@operation/status/terminal")
        return _finish(state, "invalid_evidence")
    if status in PENDING:
        if terminal or job.get("result") is not None:
            issues.append("pending_terminal_contradiction@job")
            return _finish(state, "invalid_evidence")
        return _finish(state, "queued")
    if status not in ("succeeded", "failed") or not terminal:
        issues.append("terminal_status_contradiction@job")
        return _finish(state, "invalid_evidence")
    result = job.get("result")
    if not isinstance(result, dict) or type(result.get("ok")) is not bool:
        issues.append("missing_terminal_result@job.result")
        return _finish(state, "invalid_evidence")
    if status == "failed" or result["ok"] is not True:
        return _finish(state, result.get("status") if result.get("status") in ("unknown_job", "repository_not_allowed") else "failed")
    if operation == "prepare_github_repair":
        preparation = result.get("preparation")
        if not isinstance(preparation, dict) or not isinstance(preparation.get("repository"), dict) or preparation["repository"].get("url") != repo_url or preparation["repository"].get("slug") != slug:
            issues.append("repository_binding_mismatch@preparation")
            return _finish(state, "parameter_mismatch")
        return _finish(state, "already_passing" if preparation.get("status") == "already_passing" else "preparation_ready" if preparation.get("repairable") is True and preparation.get("status") == "repair_ready" else "preparation_unverified")
    repair = result.get("repair")
    if not isinstance(repair, dict):
        issues.append("missing_repair@job.result")
        return _finish(state, "invalid_evidence")
    repository = repair.get("repository")
    if not isinstance(repository, dict) or repository.get("url") != repo_url or repository.get("slug") != slug:
        issues.append("repository_binding_mismatch@repair.repository")
        return _finish(state, "parameter_mismatch")
    if type(repair.get("verified_repair")) is not bool or not isinstance(repair.get("status"), str):
        issues.append("missing_repair_verdict@repair")
        return _finish(state, "invalid_evidence")
    if repair["verified_repair"] is False:
        if repair["status"] == "verified_repair":
            issues.append("repair_verdict_contradiction@repair")
            return _finish(state, "invalid_evidence")
        return _finish(state, "already_passing" if repair["status"] == "already_passing" else "failed" if repair["status"] in ("repair_failed", "repair_agent_failed", "repair_verification_failed", "reproduction_failed") else "repair_unverified")
    if repair["status"] != "verified_repair" or repair.get("schema_version") != "1.0" or repair.get("verifier_backend") != "docker" or not isinstance(repository.get("commit"), str) or not SHA1.fullmatch(repository["commit"]):
        issues.append("invalid_verified_repair_contract@repair")
    try:
        started, completed = _time(repair.get("started_at")), _time(repair.get("completed_at"))
    except (TypeError, ValueError):
        issues.append("missing_repair_timestamps@started_at/completed_at")
        return _finish(state, "missing_freshness_evidence")
    if started < request_start - timedelta(seconds=2) or completed < started or started > now or completed > now:
        issues.append("repair_time_binding_mismatch@started_at/completed_at")
        return _finish(state, "stale_evidence")
    before = _phase(repair.get("baseline"), "baseline", False, issues)
    after = _phase(repair.get("final_verification"), "final_verification", True, issues)
    baseline = repair.get("baseline")
    if not isinstance(baseline, dict) or not isinstance(baseline.get("preparation_baseline_sha256"), str) or not SHA256.fullmatch(baseline["preparation_baseline_sha256"]):
        issues.append("missing_baseline_binding@preparation_baseline_sha256")
    if before and after and (after["collected"] < before["collected"] or after["skipped"] > before["skipped"]):
        issues.append("pytest_scope_reduced@final_verification")
    paths = repair.get("changed_files")
    if not isinstance(paths, list) or not paths or len(paths) > 20 or any(not isinstance(path, str) or not path or path.startswith(("/", "\\")) or "\\" in path or ":" in path or ".." in path.split("/") for path in paths):
        issues.append("invalid_changed_files@repair")
    elif len(set(paths)) != len(paths) or any("tests" in path.lower().split("/") or path.rsplit("/", 1)[-1].lower().startswith("test_") or path.rsplit("/", 1)[-1].lower() in ("conftest.py", "pytest.ini", "pyproject.toml", "setup.cfg", "tox.ini") for path in paths):
        issues.append("protected_or_duplicate_changed_files@repair")
    if not isinstance(repair.get("run_id"), str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", repair["run_id"]) or not isinstance(repair.get("patch_sha256"), str) or not SHA256.fullmatch(repair["patch_sha256"]):
        issues.append("invalid_run_or_patch_identity@repair")
    if isinstance(baseline, dict) and isinstance(repair.get("final_verification"), dict):
        final = repair["final_verification"]
        if baseline.get("command") != final.get("command"):
            issues.append("command_mismatch@repair")
        if isinstance(baseline.get("execution"), dict) and isinstance(final.get("execution"), dict):
            identity = "|".join(str(value) for value in (repair.get("run_id"), repository.get("commit"), baseline.get("command"), baseline["execution"].get("exit_code"), final["execution"].get("exit_code"), repair.get("patch_sha256")))
            if repair.get("attestation_sha256") != hashlib.sha256(identity.encode("utf-8")).hexdigest():
                issues.append("attestation_mismatch@repair")
    # Stop before artifact comparison if malformed paths could make set() unsafe.
    if not issues:
        _artifact(repair, result.get("github_actions"), issues)
    receipt = mcp.get("receipt_url", "")
    if not isinstance(receipt, str) or receipt and not _safe_receipt(receipt, result.get("github_actions")):
        issues.append("invalid_public_receipt@receipt_url")
    if issues:
        return _finish(state, "invalid_evidence")
    state["receipt"] = receipt or None
    state["facts"].extend(("仓库：" + json.dumps(repository["url"].replace(job_id, "[作业 capability 已隐藏]"), ensure_ascii=False) + "；固定提交：" + _quote(repository["commit"], job_id) + "。", "修复起止：" + _quote(repair["started_at"], job_id) + " → " + _quote(repair["completed_at"], job_id) + "。", "变更文件：" + _quote(paths, job_id) + "；patch_sha256=" + _quote(repair["patch_sha256"], job_id) + "。"))
    for label, phase, counts in (("修改前", repair["baseline"], before), ("修改后", repair["final_verification"], after)):
        execution = phase["execution"]
        state["facts"].append(label + "：command=" + _quote(phase["command"], job_id) + "；exit_code=" + str(execution["exit_code"]) + "；timed_out=" + _quote(execution["timed_out"], job_id) + "；pytest=" + _quote(counts, job_id) + "。")
        state["facts"].append(label + " stdout=" + _quote(execution["stdout"], job_id) + "；stderr=" + _quote(execution["stderr"], job_id) + "。")
    return _finish(state, "verified_repair")
