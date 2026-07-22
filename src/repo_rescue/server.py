from __future__ import annotations

import os
import subprocess
from typing import Any

from mcp.server.fastmcp import FastMCP

from .analysis import analyze_snapshot
from .repository import clone_public_repository
from .runner import reproduce
from .security import SecurityError


mcp = FastMCP(
    "RepoRescue",
    instructions=(
        "Inspect public GitHub repositories and return source-linked evidence. "
        "Never claim execution unless reproduce_python_project returns verified=true."
    ),
    host=os.getenv("REPO_RESCUE_HOST", "0.0.0.0"),
    port=int(os.getenv("REPO_RESCUE_PORT", "8000")),
    stateless_http=True,
    json_response=True,
)


def _error(exc: Exception) -> dict[str, Any]:
    return {"ok": False, "error_type": type(exc).__name__, "message": str(exc)}


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
    except (SecurityError, OSError, TimeoutError) as exc:
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
        with clone_public_repository(repo_url) as snapshot:
            inspection = analyze_snapshot(snapshot)
            result = reproduce(snapshot, inspection)
            return {"ok": True, "inspection": inspection, "reproduction": result, "executed": True}
    except (SecurityError, OSError, TimeoutError, subprocess.SubprocessError) as exc:  # type: ignore[name-defined]
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
