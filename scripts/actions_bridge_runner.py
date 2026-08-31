from __future__ import annotations

import base64
import binascii
import gzip
import hashlib
import io
import json
import os
import re
import shutil
import sys
from pathlib import Path
from typing import Any

from repo_rescue.bridge import prepare_repair, verify_submitted_github_patch
from repo_rescue.security import SecurityError, normalize_github_url, redact


MAX_ENCODED_CHARS = 55_000
MAX_DECODED_BYTES = 55_000
MAX_RESULT_BYTES = 1_048_576
MAX_PLATFORM_CHANGES = 3
MAX_PLATFORM_REPLACEMENT_CHARS = 12_000
MAX_ARTIFACT_FILE_BYTES = 4 * 1_048_576
MAX_ARTIFACT_TOTAL_BYTES = 8 * 1_048_576
REQUEST_ID = re.compile(r"^[A-Za-z0-9_-]{43}$")


def _controlled_error(exc: Exception) -> dict[str, Any]:
    if isinstance(exc, (SecurityError, ValueError)):
        return {
            "ok": False,
            "status": "invalid_request",
            "error_type": type(exc).__name__,
            "message": redact(str(exc), limit=1_000),
        }
    if isinstance(exc, TimeoutError):
        return {
            "ok": False,
            "status": "timeout",
            "error_type": "TimeoutError",
            "message": "The isolated repair operation timed out.",
        }
    return {
        "ok": False,
        "status": "internal_error",
        "error_type": "InternalError",
        "message": "The isolated repair operation could not be completed safely.",
    }


def _decode_payload(encoded: str) -> dict[str, Any]:
    if not isinstance(encoded, str) or not encoded or len(encoded) > MAX_ENCODED_CHARS:
        raise ValueError(f"payload must contain at most {MAX_ENCODED_CHARS} encoded characters.")
    try:
        compressed = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ValueError("payload must be strict base64.") from exc
    try:
        with gzip.GzipFile(fileobj=io.BytesIO(compressed), mode="rb") as stream:
            raw = stream.read(MAX_DECODED_BYTES + 1)
    except (OSError, EOFError) as exc:
        raise ValueError("payload must be a valid gzip stream.") from exc
    if len(raw) > MAX_DECODED_BYTES:
        raise ValueError(f"decoded payload must contain at most {MAX_DECODED_BYTES} bytes.")
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError("payload must contain one UTF-8 JSON object.") from exc
    if not isinstance(payload, dict) or set(payload) != {"version", "mode", "arguments"}:
        raise ValueError("payload must contain only version, mode, and arguments.")
    if payload["version"] != 1 or payload["mode"] not in {"prepare", "verify"}:
        raise ValueError("payload version or mode is unsupported.")
    if not isinstance(payload["arguments"], dict):
        raise ValueError("payload arguments must be an object.")
    return payload


def _validate_repo_url(value: Any) -> tuple[str, str]:
    if not isinstance(value, str) or not 19 <= len(value) <= 500:
        raise ValueError("repo_url must be a canonical GitHub URL no longer than 500 characters.")
    canonical, slug = normalize_github_url(value)
    return canonical.removesuffix(".git"), slug


def _prepare_arguments(arguments: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    if set(arguments) != {"repo_url"}:
        raise ValueError("prepare arguments may contain only repo_url.")
    repo_url, slug = _validate_repo_url(arguments["repo_url"])
    return slug, {"repo_url": repo_url}


def _verify_arguments(arguments: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    allowed = {
        "repo_url",
        "expected_commit",
        "expected_baseline_sha256",
        "analysis",
        "issue",
        "changes",
    }
    if not set(arguments).issubset(allowed) or not {
        "repo_url",
        "expected_commit",
        "expected_baseline_sha256",
        "changes",
    }.issubset(arguments):
        raise ValueError("verify arguments do not match the patch verification contract.")
    repo_url, slug = _validate_repo_url(arguments["repo_url"])
    expected_commit = arguments["expected_commit"]
    expected_baseline = arguments["expected_baseline_sha256"]
    analysis = arguments.get("analysis", "")
    issue = arguments.get("issue", "")
    changes = arguments["changes"]
    if not isinstance(expected_commit, str) or re.fullmatch(r"[0-9a-fA-F]{40}", expected_commit) is None:
        raise ValueError("expected_commit must be the 40-character SHA returned by preparation.")
    if not isinstance(expected_baseline, str) or re.fullmatch(r"[0-9a-fA-F]{64}", expected_baseline) is None:
        raise ValueError("expected_baseline_sha256 must be the 64-character hash returned by preparation.")
    if not isinstance(analysis, str) or len(analysis) > 4_000:
        raise ValueError("analysis must be no longer than 4000 characters.")
    if not isinstance(issue, str) or len(issue) > 8_000:
        raise ValueError("issue must be no longer than 8000 characters.")
    if not isinstance(changes, list) or not 1 <= len(changes) <= MAX_PLATFORM_CHANGES:
        raise ValueError(f"changes must contain between 1 and {MAX_PLATFORM_CHANGES} replacements.")
    normalized_changes: list[dict[str, str]] = []
    for change in changes:
        if not isinstance(change, dict) or set(change) != {"path", "content"}:
            raise ValueError("Every change must contain only path and content.")
        path = change["path"]
        content = change["content"]
        if not isinstance(path, str) or not 1 <= len(path) <= 500:
            raise ValueError("Every replacement path must contain between 1 and 500 characters.")
        if not isinstance(content, str) or len(content) > MAX_PLATFORM_REPLACEMENT_CHARS:
            raise ValueError(
                f"Every platform replacement must contain at most {MAX_PLATFORM_REPLACEMENT_CHARS} characters."
            )
        normalized_changes.append({"path": path, "content": content})
    return slug, {
        "repo_url": repo_url,
        "expected_commit": expected_commit,
        "expected_baseline_sha256": expected_baseline,
        "analysis": analysis,
        "issue": issue,
        "changes": normalized_changes,
    }


def _public_repair(report: dict[str, Any], request_id: str) -> dict[str, Any]:
    run_id = report.get("run_id")
    return {
        **report,
        "artifacts": {
            "run_id": run_id,
            "available": ["patch", "evidence", "report"],
            "github_actions_artifact": f"repo-rescue-{request_id}",
            "paths": {
                "patch": f"{run_id}/repair.patch",
                "evidence": f"{run_id}/evidence.json",
                "report": f"{run_id}/report.md",
            },
        },
    }


def execute(payload: dict[str, Any], request_id: str, mode: str, output_dir: Path) -> dict[str, Any]:
    if REQUEST_ID.fullmatch(request_id) is None:
        raise ValueError("request_id must be the 43-character workflow correlation nonce.")
    if mode not in {"prepare", "verify"} or payload["mode"] != mode:
        raise ValueError("workflow mode does not match the signed bridge payload.")
    if mode == "prepare":
        slug, arguments = _prepare_arguments(payload["arguments"])
    else:
        slug, arguments = _verify_arguments(payload["arguments"])

    configured_targets = {
        item.strip().lower().removesuffix(".git")
        for item in os.getenv("REPO_RESCUE_BRIDGE_ALLOWED_REPOS", "").split(",")
        if item.strip()
    }
    if slug not in configured_targets:
        raise SecurityError(
            "This repository is not in the reviewed GitHub Actions bridge allow-list."
        )

    # The runner receives no credential in the untrusted container. Clear the
    # common host variables as defense in depth, and authorize exactly the one
    # validated public repository for this invocation.
    os.environ.pop("GITHUB_TOKEN", None)
    os.environ.pop("GH_TOKEN", None)
    os.environ["REPO_RESCUE_ALLOWED_REPOS"] = slug
    os.environ["REPO_RESCUE_EXECUTION_BACKEND"] = "docker"
    os.environ["REPO_RESCUE_PYTHON_IMAGE"] = "repo-rescue-python:3.11"

    if mode == "prepare":
        return {
            "ok": True,
            "preparation": prepare_repair(arguments["repo_url"], maximum_context_bytes=50_000),
        }

    report = verify_submitted_github_patch(
        arguments["repo_url"],
        expected_commit=arguments["expected_commit"],
        expected_baseline_sha256=arguments["expected_baseline_sha256"],
        analysis=arguments["analysis"],
        changes=arguments["changes"],
        issue=arguments["issue"],
        artifacts_root=output_dir,
    )
    artifact_root = output_dir / str(report.get("run_id", ""))
    artifact_paths = [
        artifact_root / "repair.patch",
        artifact_root / "evidence.json",
        artifact_root / "report.md",
    ]
    sizes = [path.stat().st_size for path in artifact_paths if path.is_file() and not path.is_symlink()]
    if len(sizes) != 3 or any(size > MAX_ARTIFACT_FILE_BYTES for size in sizes) or sum(sizes) > MAX_ARTIFACT_TOTAL_BYTES:
        shutil.rmtree(artifact_root, ignore_errors=True)
        raise RuntimeError("Generated repair artifacts exceeded the bridge storage boundary.")
    return {"ok": True, "repair": _public_repair(report, request_id)}


def _write_github_output(request_id: str) -> None:
    output_path = os.getenv("GITHUB_OUTPUT", "")
    if not output_path or REQUEST_ID.fullmatch(request_id) is None:
        return
    with Path(output_path).open("a", encoding="utf-8", newline="\n") as stream:
        stream.write(f"artifact_name=repo-rescue-{request_id}\n")


def main() -> int:
    request_id = os.getenv("REPO_RESCUE_BRIDGE_REQUEST_ID", "")
    mode = os.getenv("REPO_RESCUE_BRIDGE_MODE", "")
    encoded = os.getenv("REPO_RESCUE_BRIDGE_PAYLOAD", "")
    github_run_id = os.getenv("GITHUB_RUN_ID", "")
    github_sha = os.getenv("GITHUB_SHA", "")
    output_dir = Path(os.getenv("REPO_RESCUE_BRIDGE_OUTPUT", "bridge-output")).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    try:
        if re.fullmatch(r"[1-9][0-9]{0,19}", github_run_id) is None:
            raise ValueError("GITHUB_RUN_ID is unavailable or invalid.")
        if re.fullmatch(r"[0-9a-fA-F]{40}", github_sha) is None:
            raise ValueError("GITHUB_SHA is unavailable or invalid.")
        payload = _decode_payload(encoded)
        result = execute(payload, request_id, mode, output_dir)
    except Exception as exc:  # The artifact must exist even when execution fails.
        result = _controlled_error(exc)
    if not isinstance(result.get("ok"), bool):
        result = {
            "ok": False,
            "status": "internal_error",
            "error_type": "InternalError",
            "message": "The isolated repair operation returned an invalid result contract.",
        }
    envelope = {
        "request_id": request_id,
        "mode": mode,
        "payload_sha256": hashlib.sha256(encoded.encode("utf-8")).hexdigest(),
        "github_run_id": github_run_id,
        "github_sha": github_sha,
        "result": result,
    }
    encoded_result = json.dumps(envelope, ensure_ascii=False, indent=2).encode("utf-8")
    if len(encoded_result) > MAX_RESULT_BYTES:
        envelope = {
            "request_id": request_id,
            "mode": mode,
            "payload_sha256": hashlib.sha256(encoded.encode("utf-8")).hexdigest(),
            "github_run_id": github_run_id,
            "github_sha": github_sha,
            "result": {
                "ok": False,
                "status": "result_too_large",
                "error_type": "ResultLimitError",
                "message": "The repair result exceeded the GitHub Actions bridge output limit.",
            },
        }
        encoded_result = json.dumps(envelope, ensure_ascii=False, indent=2).encode("utf-8")
    (output_dir / "result.json").write_bytes(encoded_result)
    _write_github_output(request_id)
    return 0 if envelope["result"].get("ok") is True else 1


if __name__ == "__main__":
    sys.exit(main())
