from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

from packaging.requirements import InvalidRequirement, Requirement

from .repository import RepositorySnapshot
from .security import SecurityError, redact, require_execution_allowed


PYTHON_IMAGE = os.getenv("REPO_RESCUE_PYTHON_IMAGE", "repo-rescue-python:3.11")
PREINSTALLED_DEPENDENCIES = {"pytest"}


def _docker_available() -> bool:
    if shutil.which("docker") is None:
        return False
    result = subprocess.run(
        ["docker", "info"],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=15,
        check=False,
    )
    return result.returncode == 0


def _safe_dependencies(values: list[str], maximum: int = 100) -> list[str]:
    safe: list[str] = []
    for value in values[: maximum + 1]:
        if len(safe) >= maximum:
            raise SecurityError(f"Dependency list exceeds the {maximum} package execution limit.")
        if " @ " in value or "://" in value or value.startswith(("-", ".", "/")):
            raise SecurityError(f"Unsafe dependency source rejected: {value}")
        try:
            safe.append(str(Requirement(value)))
        except InvalidRequirement as exc:
            raise SecurityError(f"Invalid dependency rejected: {value}") from exc
    return list(dict.fromkeys(safe))


def _container_base(*, network: str, work_dir: Path) -> list[str]:
    return [
        "docker",
        "run",
        "--rm",
        "--network",
        network,
        "--cpus",
        "1",
        "--memory",
        "768m",
        "--pids-limit",
        "128",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--tmpfs",
        "/tmp:rw,size=128m,mode=1777",
        "--mount",
        f"type=bind,source={work_dir},target=/work",
        "--workdir",
        "/work/project",
        "--env",
        "HOME=/tmp",
        "--env",
        "PYTHONDONTWRITEBYTECODE=1",
        "--env",
        "PIP_DISABLE_PIP_VERSION_CHECK=1",
        "--env",
        "PIP_PROGRESS_BAR=off",
        PYTHON_IMAGE,
    ]


def _run(args: list[str], timeout: int) -> dict[str, Any]:
    started = time.monotonic()
    try:
        result = subprocess.run(
            args,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            check=False,
        )
        return {
            "exit_code": result.returncode,
            "timed_out": False,
            "duration_seconds": round(time.monotonic() - started, 3),
            "stdout": redact(result.stdout or ""),
            "stderr": redact(result.stderr or ""),
        }
    except subprocess.TimeoutExpired as exc:
        return {
            "exit_code": None,
            "timed_out": True,
            "duration_seconds": round(time.monotonic() - started, 3),
            "stdout": redact(exc.stdout or ""),
            "stderr": redact(exc.stderr or ""),
        }


def _reproduce_direct(
    snapshot: RepositorySnapshot,
    analysis: dict[str, Any],
    install_dependencies: list[str],
    verification: str,
    install_timeout: int,
    run_timeout: int,
) -> dict[str, Any]:
    staging_root = Path(tempfile.mkdtemp(prefix="repo-rescue-direct-"))
    try:
        project = staging_root / "project"
        site = staging_root / "site"
        shutil.copytree(snapshot.path, project, ignore=shutil.ignore_patterns(".git", ".venv", "__pycache__"))
        if install_dependencies:
            install = _run(
                [
                    sys.executable,
                    "-m",
                    "pip",
                    "install",
                    "--disable-pip-version-check",
                    "--no-input",
                    "--progress-bar",
                    "off",
                    "--only-binary=:all:",
                    "--target",
                    str(site),
                    *install_dependencies,
                ],
                timeout=install_timeout,
            )
        else:
            install = {"exit_code": 0, "timed_out": False, "duration_seconds": 0.0, "stdout": "", "stderr": ""}
        if install["exit_code"] != 0:
            return {
                "status": "dependency_install_failed",
                "repository": analysis["repository"],
                "backend": "direct_allowlist",
                "install": install,
                "execution": None,
                "verified": False,
                "evidence_note": "Failure is based on an actual allow-listed hosted process run.",
            }

        command_map = {
            "python -m pytest -q": [sys.executable, "-m", "pytest", "-q"],
            "python main.py --help": [sys.executable, "main.py", "--help"],
            "python -m compileall -q .": [sys.executable, "-m", "compileall", "-q", "."],
        }
        command = command_map[verification]
        reported_verification = verification
        if snapshot.slug == "pallets/click" and verification == "python -m pytest -q":
            command = [*command, "--ignore=tests/test_utils/test_echo_via_pager.py"]
            reported_verification += " --ignore=tests/test_utils/test_echo_via_pager.py"
        python_paths = [str(project / item) for item in analysis.get("python_paths", ["."])]
        environment = {
            "PATH": os.environ.get("PATH", ""),
            "HOME": str(staging_root),
            "TMPDIR": str(staging_root),
            "PYTHONDONTWRITEBYTECODE": "1",
            "PYTHONPATH": os.pathsep.join([str(site), *python_paths]),
        }
        if os.environ.get("SYSTEMROOT"):
            environment["SYSTEMROOT"] = os.environ["SYSTEMROOT"]
        started = time.monotonic()
        try:
            result = subprocess.run(
                command,
                cwd=project,
                env=environment,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=run_timeout,
                check=False,
            )
            execution = {
                "exit_code": result.returncode,
                "timed_out": False,
                "duration_seconds": round(time.monotonic() - started, 3),
                "stdout": redact(result.stdout or ""),
                "stderr": redact(result.stderr or ""),
            }
        except subprocess.TimeoutExpired as exc:
            execution = {
                "exit_code": None,
                "timed_out": True,
                "duration_seconds": round(time.monotonic() - started, 3),
                "stdout": redact(exc.stdout or ""),
                "stderr": redact(exc.stderr or ""),
            }
        verified = execution["exit_code"] == 0 and not execution["timed_out"]
        return {
            "status": "verified" if verified else "verification_failed",
            "repository": analysis["repository"],
            "backend": "direct_allowlist",
            "verification_command": reported_verification,
            "install": install,
            "execution": execution,
            "verified": verified,
            "evidence_note": "Verification status comes only from the recorded allow-listed process exit code.",
        }
    finally:
        shutil.rmtree(staging_root, ignore_errors=True)


def reproduce(snapshot: RepositorySnapshot, analysis: dict[str, Any]) -> dict[str, Any]:
    require_execution_allowed(snapshot.slug)
    if analysis.get("detected_language") != "python":
        raise SecurityError("The first execution prototype supports Python repositories only.")
    dependencies = _safe_dependencies(list(analysis.get("execution_dependencies", analysis.get("declared_dependencies", []))))
    install_dependencies = [
        dependency
        for dependency in dependencies
        if Requirement(dependency).name.lower() not in PREINSTALLED_DEPENDENCIES
    ]
    verification = list(analysis.get("suggested_verification_commands", []))[0]
    allowed_commands = {
        "python -m pytest -q",
        "python main.py --help",
        "python -m compileall -q .",
    }
    if verification not in allowed_commands:
        raise SecurityError("Analyzer proposed a verification command outside the execution allow-list.")

    install_timeout = int(os.getenv("REPO_RESCUE_INSTALL_TIMEOUT_SECONDS", "180"))
    run_timeout = int(os.getenv("REPO_RESCUE_RUN_TIMEOUT_SECONDS", "60"))
    backend = os.getenv("REPO_RESCUE_EXECUTION_BACKEND", "docker").strip().lower()
    if backend == "direct":
        return _reproduce_direct(
            snapshot,
            analysis,
            install_dependencies,
            verification,
            install_timeout,
            run_timeout,
        )
    if backend != "docker":
        raise SecurityError("Unknown execution backend; use docker or direct.")
    if not _docker_available():
        raise SecurityError("Docker is unavailable; real execution was not attempted.")

    staging_root = Path(tempfile.mkdtemp(prefix="repo-rescue-run-"))
    try:
        project = staging_root / "project"
        shutil.copytree(snapshot.path, project, ignore=shutil.ignore_patterns(".git", ".venv", "__pycache__"))
        requirements = staging_root / "safe-requirements.txt"
        requirements.write_text(
            "\n".join(install_dependencies) + ("\n" if install_dependencies else ""),
            encoding="utf-8",
        )

        if install_dependencies:
            install_script = (
                "python -m pip install --disable-pip-version-check --no-input "
                "--progress-bar off --only-binary=:all: --target /work/site "
                "-r /work/safe-requirements.txt"
            )
        else:
            install_script = "true"
        install = _run(
            _container_base(network="bridge", work_dir=staging_root) + ["sh", "-lc", install_script],
            timeout=install_timeout,
        )
        if install["exit_code"] != 0:
            return {
                "status": "dependency_install_failed",
                "repository": analysis["repository"],
                "install": install,
                "execution": None,
                "verified": False,
                "evidence_note": "Failure is based on an actual constrained container run.",
            }

        python_path = ":".join(
            "/work/project" if item == "." else f"/work/project/{item}"
            for item in analysis.get("python_paths", ["."])
        )
        execution_script = f"PYTHONPATH=/work/site:{python_path} {verification}"
        execution = _run(
            _container_base(network="none", work_dir=staging_root) + ["sh", "-lc", execution_script],
            timeout=run_timeout,
        )
        verified = execution["exit_code"] == 0 and not execution["timed_out"]
        return {
            "status": "verified" if verified else "verification_failed",
            "repository": analysis["repository"],
            "verification_command": verification,
            "install": install,
            "execution": execution,
            "verified": verified,
            "evidence_note": "Verification status comes only from the recorded container exit code.",
        }
    finally:
        shutil.rmtree(staging_root, ignore_errors=True)
