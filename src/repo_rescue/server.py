from __future__ import annotations

import os
import re
import subprocess
from pathlib import Path
from typing import Any

from mcp.server.fastmcp import FastMCP
from pydantic import BaseModel, ConfigDict, Field

from .analysis import analyze_snapshot
from .artifacts import read_artifact_chunk
from .bridge import prepare_repair, verify_submitted_github_patch
from .orchestrator import run_builtin_demo, run_github_repair
from .repository import clone_public_repository
from .runner import reproduce
from .security import SecurityError, normalize_github_url, redact, require_execution_allowed


class PatchChange(BaseModel):
    model_config = ConfigDict(extra="forbid")

    path: str = Field(min_length=1, max_length=500)
    content: str = Field(max_length=256_000)


mcp = FastMCP(
    "RepoRescue",
    instructions=(
        "Inspect and repair explicitly allow-listed public GitHub repositories with source-linked evidence. "
        "For an API-key-free host-agent repair, call prepare_github_repair, generate bounded complete-file "
        "replacements from its untrusted context, then call verify_github_patch. Never claim a repair unless "
        "the final tool result contains verified_repair=true."
    ),
    host=os.getenv("REPO_RESCUE_HOST", "0.0.0.0"),
    port=int(os.getenv("REPO_RESCUE_PORT", "8000")),
    stateless_http=True,
    json_response=True,
)


_WINDOWS_ABSOLUTE_PATH = re.compile(r"(?<![A-Za-z0-9_])[A-Za-z]:[\\/][^\r\n\t <>\"|?*]+")
_UNC_ABSOLUTE_PATH = re.compile(r"\\\\[^\s\\/]+[\\/][^\r\n\t <>\"|?*]+")
_POSIX_ABSOLUTE_PATH = re.compile(r"(?<![:/A-Za-z0-9_.-])/(?:[^\r\n\t <>\"']+)")


def _controlled_error_message(exc: SecurityError | ValueError) -> str:
    """Return a bounded message for errors whose text RepoRescue controls.

    Security and validation errors are useful to callers, but they can include
    an offending value. Scrub secrets and host-shaped absolute paths before
    crossing the MCP boundary.
    """
    message = redact(str(exc), limit=1_000)
    for pattern in (_WINDOWS_ABSOLUTE_PATH, _UNC_ABSOLUTE_PATH, _POSIX_ABSOLUTE_PATH):
        message = pattern.sub("<path>", message)
    return message or "The request was rejected."


def _error(exc: Exception) -> dict[str, Any]:
    if isinstance(exc, (SecurityError, ValueError)):
        return {
            "ok": False,
            "error_type": type(exc).__name__,
            "message": _controlled_error_message(exc),
        }
    if isinstance(exc, (TimeoutError, subprocess.TimeoutExpired)):
        return {
            "ok": False,
            "error_type": "TimeoutError",
            "message": "The operation timed out before it could complete.",
        }
    # OSError, RuntimeError and subprocess exceptions commonly contain host
    # paths, commands, or provider-specific diagnostics. Keep those details in
    # server-side evidence only and expose a stable failure contract here.
    return {
        "ok": False,
        "error_type": "InternalError",
        "message": "The operation could not be completed safely.",
    }


def _public_repair_result(report: dict[str, Any]) -> dict[str, Any]:
    """Remove server-local paths while preserving artifact retrieval metadata."""
    return {
        **report,
        "artifacts": {
            "run_id": report.get("run_id"),
            "available": ["patch", "evidence", "report"],
            "retrieval_tool": "get_repair_artifact",
        },
    }


@mcp.tool()
def inspect_github_project(repo_url: str) -> dict[str, Any]:
    """Inspect a public GitHub repository without executing its code.

    Use this first when a student supplies a GitHub URL. The result contains a
    commit SHA, manifests, dependency declarations, Python-version hints,
    bounded file evidence, risks and suggested verification commands.
    """
    try:
        with clone_public_repository(repo_url) as snapshot:
            return {"ok": True, "inspection": analyze_snapshot(snapshot), "executed": False}
    except (SecurityError, OSError, TimeoutError, subprocess.SubprocessError) as exc:
        return _error(exc)


@mcp.tool()
def reproduce_python_project(repo_url: str) -> dict[str, Any]:
    """Run an explicitly allow-listed public Python repository and record evidence.

    The Docker backend separates installation from offline, resource-constrained
    execution. Managed hosts can use a timeout-bounded direct fallback for the
    same fixed repository and command allow-lists. Arbitrary shell commands are
    never accepted.
    """
    try:
        _, slug = normalize_github_url(repo_url)
        require_execution_allowed(slug)
        with clone_public_repository(repo_url) as snapshot:
            inspection = analyze_snapshot(snapshot)
            result = reproduce(snapshot, inspection)
            return {"ok": True, "inspection": inspection, "reproduction": result, "executed": True}
    except (SecurityError, OSError, TimeoutError, subprocess.SubprocessError) as exc:  # type: ignore[name-defined]
        return _error(exc)


@mcp.tool()
def repair_github_project(
    repo_url: str,
    issue: str = "",
    max_attempts: int = 2,
    model: str | None = None,
) -> dict[str, Any]:
    """Run the repository-level repair loop and persist patch evidence.

    The original public repository is commit-pinned and never modified remotely.
    Its failing verification command is recorded, an OpenAI Repair Agent may
    replace bounded non-test source files, and the exact same command is rerun.
    A repair is verified only when the original fails and the patched checkout
    passes. Docker execution and REPO_RESCUE_ALLOWED_REPOS are required.
    """
    try:
        artifacts = Path(os.getenv("REPO_RESCUE_ARTIFACTS_DIR", "artifacts"))
        return {
            "ok": True,
            "repair": _public_repair_result(
                run_github_repair(
                    repo_url,
                    issue=issue,
                    artifacts_root=artifacts,
                    max_attempts=max_attempts,
                    model=model,
                )
            ),
        }
    except (SecurityError, OSError, TimeoutError, ValueError, RuntimeError, subprocess.SubprocessError) as exc:
        return _error(exc)


@mcp.tool()
def prepare_github_repair(repo_url: str) -> dict[str, Any]:
    """Prepare an API-key-free repository repair for the surrounding host agent.

    The tool authorizes the repository before cloning, reproduces the fixed
    verifier command, and returns bounded source/config context. This result is
    preparation evidence only; it is never a verified repair by itself.
    """
    try:
        maximum_context_bytes = int(os.getenv("REPO_RESCUE_HOST_AGENT_CONTEXT_BYTES", "60000"))
        return {"ok": True, "preparation": prepare_repair(repo_url, maximum_context_bytes=maximum_context_bytes)}
    except (SecurityError, OSError, TimeoutError, ValueError, RuntimeError, subprocess.SubprocessError) as exc:
        return _error(exc)


@mcp.tool()
def verify_github_patch(
    repo_url: str,
    expected_commit: str,
    expected_baseline_sha256: str,
    changes: list[PatchChange],
    analysis: str = "",
    issue: str = "",
) -> dict[str, Any]:
    """Verify complete-file replacements generated by the surrounding host agent.

    The repository must still match the commit and baseline_sha256 returned by
    prepare_github_repair. The backend reruns the original baseline, safely
    applies bounded changes, and reruns the exact same verifier command. No
    model API key is required because the host agent generated the proposal.
    """
    try:
        artifacts = Path(os.getenv("REPO_RESCUE_ARTIFACTS_DIR", "artifacts"))
        return {
            "ok": True,
            "repair": _public_repair_result(
                verify_submitted_github_patch(
                    repo_url,
                    expected_commit=expected_commit,
                    expected_baseline_sha256=expected_baseline_sha256,
                    analysis=analysis,
                    changes=[change.model_dump() for change in changes],
                    issue=issue,
                    artifacts_root=artifacts,
                )
            ),
        }
    except (SecurityError, OSError, TimeoutError, ValueError, RuntimeError, subprocess.SubprocessError) as exc:
        return _error(exc)


@mcp.tool()
def run_interview_demo() -> dict[str, Any]:
    """Run a deterministic end-to-end repair demo without Docker or an API key.

    The bundled trusted project fails in a newly created virtual environment,
    receives a real source edit, passes the exact same test command, and emits
    repair.patch, evidence.json, and report.md.
    """
    try:
        artifacts = Path(os.getenv("REPO_RESCUE_ARTIFACTS_DIR", "artifacts"))
        return {"ok": True, "repair": _public_repair_result(run_builtin_demo(artifacts_root=artifacts))}
    except (SecurityError, OSError, TimeoutError, ValueError, RuntimeError, subprocess.SubprocessError) as exc:
        return _error(exc)


@mcp.tool()
def get_repair_artifact(
    run_id: str,
    artifact: str,
    offset: int = 0,
    limit: int = 60_000,
) -> dict[str, Any]:
    """Return a bounded chunk of a generated patch, report, or evidence file.

    Use the run_id returned by repair_github_project, verify_github_patch, or
    run_interview_demo. Large artifacts can be retrieved with the returned
    next_offset; callers never provide a filesystem path.
    """
    try:
        root = Path(os.getenv("REPO_RESCUE_ARTIFACTS_DIR", "artifacts"))
        return {
            "ok": True,
            "artifact": read_artifact_chunk(
                root,
                run_id=run_id,
                artifact=artifact,
                offset=offset,
                limit=limit,
            ),
        }
    except (SecurityError, OSError, ValueError) as exc:
        return _error(exc)


@mcp.tool()
def windows_environment_probe() -> dict[str, Any]:
    """Return a safe copy-paste PowerShell probe for local Python evidence.

    The command reads versions and installed package metadata only. It does not
    modify files, install software or transmit information automatically.
    """
    command = (
        "$ErrorActionPreference='Continue'; "
        "Write-Output '=== SYSTEM ==='; "
        "Get-CimInstance Win32_OperatingSystem | Select-Object Caption,Version,OSArchitecture; "
        "Write-Output '=== PY LAUNCHER ==='; py -0p; "
        "Write-Output '=== PYTHON ==='; python --version; "
        "Write-Output '=== PIP ==='; python -m pip --version; "
        "Write-Output '=== PACKAGES ==='; python -m pip list --format=freeze"
    )
    return {
        "ok": True,
        "platform": "windows",
        "command": command,
        "changes_system": False,
        "instructions": "Run in PowerShell, review the output, then paste only the relevant result back into RepoRescue.",
    }


def main() -> None:
    transport = os.getenv("REPO_RESCUE_TRANSPORT", "streamable-http").strip().lower()
    if transport == "stdio":
        mcp.run(transport="stdio")
        return
    if transport != "streamable-http":
        raise ValueError("REPO_RESCUE_TRANSPORT must be streamable-http or stdio.")
    mcp.run(transport="streamable-http")


if __name__ == "__main__":
    main()
