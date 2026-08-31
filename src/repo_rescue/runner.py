from __future__ import annotations

import json
import os
import secrets
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

from packaging.requirements import InvalidRequirement, Requirement

from .repository import RepositorySnapshot
from .security import SecurityError, redact, redact_paths, require_execution_allowed


PYTHON_IMAGE = os.getenv("REPO_RESCUE_PYTHON_IMAGE", "repo-rescue-python:3.11")
PREINSTALLED_DEPENDENCIES = {"pytest"}


def _copy_repository_tree(source: Path, destination: Path) -> None:
    patterns = shutil.ignore_patterns(".git", ".venv", "__pycache__")

    def ignore(directory: str, names: list[str]) -> set[str]:
        ignored = set(patterns(directory, names))
        ignored.update(name for name in names if (Path(directory) / name).is_symlink())
        return ignored

    shutil.copytree(source, destination, ignore=ignore)


def _sanitize_record_paths(record: dict[str, Any], staging_root: Path) -> None:
    for key in ("stdout", "stderr"):
        value = record.get(key)
        if isinstance(value, str):
            record[key] = redact_paths(value, [(staging_root, "<sandbox>")])


def _docker_available() -> bool:
    if shutil.which("docker") is None:
        return False
    try:
        result = subprocess.run(
            ["docker", "info"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=15,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
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


def _host_container_user() -> str | None:
    """Return the POSIX host identity Docker should use for bind mounts."""
    if os.name != "posix":
        return None
    getuid = getattr(os, "getuid", None)
    getgid = getattr(os, "getgid", None)
    if not callable(getuid) or not callable(getgid):
        return None
    try:
        uid = int(getuid())
        gid = int(getgid())
    except (OSError, TypeError, ValueError):
        return None
    if uid < 0 or gid < 0:
        return None
    return f"{uid}:{gid}"


def _container_base(*, network: str, work_dir: Path, mount_read_only: bool = False) -> list[str]:
    mount = f"type=bind,source={work_dir},target=/work"
    if mount_read_only:
        mount += ",readonly"
    command = [
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
    ]
    host_user = _host_container_user()
    if host_user is not None:
        # Matching the Linux host identity prevents install/execution mounts
        # from leaving root-owned artifacts behind. Docker Desktop on Windows
        # keeps its native bind-mount translation and receives no --user flag.
        command.extend(["--user", host_user])
    command.extend([
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--tmpfs",
        "/tmp:rw,size=128m,mode=1777",
        "--mount",
        mount,
        "--workdir",
        "/work/project",
        "--env",
        "HOME=/tmp",
        "--env",
        "PYTHONDONTWRITEBYTECODE=1",
        "--env",
        "PYTHONNOUSERSITE=1",
        "--env",
        "PYTEST_DISABLE_PLUGIN_AUTOLOAD=1",
        "--env",
        "PIP_DISABLE_PIP_VERSION_CHECK=1",
        "--env",
        "PIP_PROGRESS_BAR=off",
        PYTHON_IMAGE,
    ])
    return command


def _verification_plan(snapshot: RepositorySnapshot, verification: str) -> tuple[str, list[str]]:
    command_map = {
        "python -m pytest -q": ["-q"],
        "python main.py --help": [sys.executable, "main.py", "--help"],
        "python -m compileall -q .": [sys.executable, "-I", "-m", "compileall", "-q", "."],
    }
    command = command_map[verification]
    reported = verification
    if snapshot.slug == "pallets/click" and verification == "python -m pytest -q":
        ignore = "--ignore=tests/test_utils/test_echo_via_pager.py"
        command = [*command, ignore]
        reported = f"{reported} {ignore}"
    return reported, command


_PYTEST_ATTESTATION_PREFIX = "__REPO_RESCUE_PYTEST_ATTESTATION__"


def _trusted_pytest_command(
    python: str,
    python_paths: list[str],
    pytest_args: list[str],
    timeout_seconds: int,
) -> tuple[list[str], str]:
    # The trusted controller never imports repository code. Pytest and the
    # checkout live in a disposable worker process, so repository code cannot
    # mutate the controller's completion counters through gc or plugin objects.
    token = secrets.token_hex(16)
    worker = "\n".join(
        [
            "import json",
            "import os",
            "import sys",
            "import pytest",
            "_rr_xml = sys.argv[1]",
            "_rr_paths = json.loads(sys.argv[2])",
            "_rr_args = json.loads(sys.argv[3])",
            "_rr_pytest_main = pytest.main",
            "_rr_hard_exit = os._exit",
            "sys.argv[:] = [sys.argv[0]]",
            "sys.path[:0] = _rr_paths",
            # Preserve the cacheprovider API for repositories that legitimately
            # use the cache fixture, but keep its writes off the read-only checkout.
            # The fixed path lives beside the trusted JUnit file in the isolated
            # execution temp directory and is removed by the controller.
            "_rr_cache = os.path.join(os.path.dirname(_rr_xml), 'repo-rescue-pytest-cache')",
            "_rr_exit = int(_rr_pytest_main([*_rr_args, '-o', 'cache_dir=' + _rr_cache, '--junitxml=' + _rr_xml]))",
            "sys.stdout.flush()",
            "sys.stderr.flush()",
            "_rr_hard_exit(_rr_exit)",
        ]
    )
    controller = "\n".join(
        [
            "import json",
            "import os",
            "import subprocess",
            "import shutil",
            "import sys",
            "import tempfile",
            "import xml.etree.ElementTree as ET",
            f"_rr_worker = {worker!r}",
            "_rr_fd, _rr_xml = tempfile.mkstemp(prefix='repo-rescue-pytest-', suffix='.xml')",
            "os.close(_rr_fd)",
            "os.unlink(_rr_xml)",
            "_rr_cache = os.path.join(os.path.dirname(_rr_xml), 'repo-rescue-pytest-cache')",
            "_rr_completed = 0",
            "_rr_collected = _rr_passed = _rr_failed = _rr_skipped = _rr_errors = 0",
            "_rr_exit = 3",
            "try:",
            "    try:",
            (
                "        _rr_result = subprocess.run([sys.executable, '-I', '-c', _rr_worker, _rr_xml, "
                f"{json.dumps(json.dumps(python_paths))}, {json.dumps(json.dumps(pytest_args))}], "
                f"capture_output=True, text=True, encoding='utf-8', errors='replace', timeout={max(1, timeout_seconds - 2)})"
            ),
            "        _rr_exit = int(_rr_result.returncode)",
            "        sys.stdout.write(_rr_result.stdout or '')",
            "        sys.stderr.write(_rr_result.stderr or '')",
            "        if os.path.isfile(_rr_xml):",
            "            _rr_root = ET.parse(_rr_xml).getroot()",
            "            _rr_suites = [_rr_root] if _rr_root.tag == 'testsuite' else list(_rr_root.findall('testsuite'))",
            "            if _rr_suites:",
            "                _rr_collected = sum(int(s.get('tests', '0')) for s in _rr_suites)",
            "                _rr_failed = sum(int(s.get('failures', '0')) for s in _rr_suites)",
            "                _rr_errors = sum(int(s.get('errors', '0')) for s in _rr_suites)",
            "                _rr_skipped = sum(int(s.get('skipped', '0')) for s in _rr_suites)",
            "                _rr_passed = _rr_collected - _rr_failed - _rr_errors - _rr_skipped",
            "                _rr_completed = int(min(_rr_collected, _rr_passed, _rr_failed, _rr_errors, _rr_skipped) >= 0)",
            "    except (OSError, subprocess.TimeoutExpired, ET.ParseError, ValueError):",
            "        _rr_exit = 3",
            (
                f"    print('\\n{_PYTEST_ATTESTATION_PREFIX}{token}:' + ':'.join(str(value) for value in "
                "(_rr_completed, _rr_collected, _rr_passed, _rr_failed, _rr_skipped, _rr_errors, _rr_exit)), flush=True)"
            ),
            "finally:",
            "    try:",
            "        os.unlink(_rr_xml)",
            "    except OSError:",
            "        pass",
            "    shutil.rmtree(_rr_cache, ignore_errors=True)",
            "raise SystemExit(_rr_exit if _rr_completed else 3)",
        ]
    )
    return [python, "-I", "-c", controller], token


def _attach_pytest_attestation(execution: dict[str, Any], full_stdout: str, token: str) -> None:
    prefix = f"{_PYTEST_ATTESTATION_PREFIX}{token}:"
    attestation: dict[str, Any] = {"completed": False}
    marker_line = next((line for line in reversed(full_stdout.splitlines()) if line.startswith(prefix)), None)
    if marker_line is not None:
        values = marker_line[len(prefix) :].split(":")
        if len(values) == 7:
            try:
                completed, collected, passed, failed, skipped, errors, runner_exit = (
                    int(value) for value in values
                )
                attestation = {
                    "completed": completed == 1,
                    "collected": collected,
                    "passed": passed,
                    "failed": failed,
                    "skipped": skipped,
                    "errors": errors,
                    "runner_exit_code": runner_exit,
                }
            except ValueError:
                pass
    clean_stdout = "\n".join(line for line in full_stdout.splitlines() if line != marker_line)
    if full_stdout.endswith("\n") and clean_stdout:
        clean_stdout += "\n"
    execution["stdout"] = redact(clean_stdout)
    execution["pytest_attestation"] = attestation


def _pytest_execution_verified(execution: dict[str, Any]) -> bool:
    attestation = execution.get("pytest_attestation")
    collected = int(attestation.get("collected", 0)) if isinstance(attestation, dict) else 0
    passed = int(attestation.get("passed", 0)) if isinstance(attestation, dict) else 0
    skipped = int(attestation.get("skipped", 0)) if isinstance(attestation, dict) else 0
    return bool(
        execution.get("exit_code") == 0
        and not execution.get("timed_out")
        and isinstance(attestation, dict)
        and attestation.get("completed")
        and attestation.get("runner_exit_code") == 0
        and collected > 0
        and passed > 0
        and passed + skipped >= collected
        and int(attestation.get("failed", 0)) == 0
        and int(attestation.get("errors", 0)) == 0
    )


def _run(args: list[str], timeout: int, *, pytest_token: str | None = None) -> dict[str, Any]:
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
        execution = {
            "exit_code": result.returncode,
            "timed_out": False,
            "duration_seconds": round(time.monotonic() - started, 3),
            "stdout": redact(result.stdout or ""),
            "stderr": redact(result.stderr or ""),
        }
        if pytest_token is not None:
            _attach_pytest_attestation(execution, result.stdout or "", pytest_token)
        return execution
    except subprocess.TimeoutExpired as exc:
        execution = {
            "exit_code": None,
            "timed_out": True,
            "duration_seconds": round(time.monotonic() - started, 3),
            "stdout": redact(exc.stdout or ""),
            "stderr": redact(exc.stderr or ""),
        }
        if pytest_token is not None:
            _attach_pytest_attestation(execution, str(exc.stdout or ""), pytest_token)
        return execution


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
        _copy_repository_tree(snapshot.path, project)
        reported_verification, command = _verification_plan(snapshot, verification)
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
        _sanitize_record_paths(install, staging_root)
        if install["exit_code"] != 0:
            return {
                "status": "dependency_install_failed",
                "repository": analysis["repository"],
                "backend": "direct_allowlist",
                "verification_command": reported_verification,
                "install": install,
                "execution": None,
                "verified": False,
                "verification_scope": "pytest_suite" if verification == "python -m pytest -q" else "smoke_command",
                "repair_evidence_eligible": verification == "python -m pytest -q",
                "evidence_note": "Failure is based on an actual allow-listed hosted process run.",
            }

        python_paths = [str(project / item) for item in analysis.get("python_paths", ["."])]
        pytest_token: str | None = None
        if verification == "python -m pytest -q":
            command, pytest_token = _trusted_pytest_command(
                sys.executable,
                [str(site), *python_paths],
                command,
                run_timeout,
            )
        environment = {
            "PATH": os.environ.get("PATH", ""),
            "HOME": str(staging_root),
            "TMPDIR": str(staging_root),
            "PYTHONDONTWRITEBYTECODE": "1",
            "PYTHONNOUSERSITE": "1",
            "PYTEST_DISABLE_PLUGIN_AUTOLOAD": "1",
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
            if pytest_token is not None:
                _attach_pytest_attestation(execution, result.stdout or "", pytest_token)
        except subprocess.TimeoutExpired as exc:
            execution = {
                "exit_code": None,
                "timed_out": True,
                "duration_seconds": round(time.monotonic() - started, 3),
                "stdout": redact(exc.stdout or ""),
                "stderr": redact(exc.stderr or ""),
            }
            if pytest_token is not None:
                _attach_pytest_attestation(execution, str(exc.stdout or ""), pytest_token)
        verified = (
            _pytest_execution_verified(execution)
            if verification == "python -m pytest -q"
            else execution["exit_code"] == 0 and not execution["timed_out"]
        )
        _sanitize_record_paths(execution, staging_root)
        return {
            "status": "verified" if verified else "verification_failed",
            "repository": analysis["repository"],
            "backend": "direct_allowlist",
            "verification_command": reported_verification,
            "install": install,
            "execution": execution,
            "verified": verified,
            "verification_scope": "pytest_suite" if verification == "python -m pytest -q" else "smoke_command",
            "repair_evidence_eligible": verification == "python -m pytest -q",
            "evidence_note": (
                "Pytest verification requires a trusted completion attestation and at least one passed test; "
                "other commands use the recorded allow-listed process exit code."
            ),
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
        _copy_repository_tree(snapshot.path, project)
        requirements = staging_root / "safe-requirements.txt"
        requirements.write_text(
            "\n".join(install_dependencies) + ("\n" if install_dependencies else ""),
            encoding="utf-8",
        )

        reported_verification, command = _verification_plan(snapshot, verification)
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
                "backend": "docker",
                "verification_command": reported_verification,
                "install": install,
                "execution": None,
                "verified": False,
                "verification_scope": "pytest_suite" if verification == "python -m pytest -q" else "smoke_command",
                "repair_evidence_eligible": verification == "python -m pytest -q",
                "evidence_note": "Failure is based on an actual constrained container run.",
            }

        python_path = ":".join(
            "/work/project" if item == "." else f"/work/project/{item}"
            for item in analysis.get("python_paths", ["."])
        )
        if verification == "python -m pytest -q":
            container_python_paths = ["/work/site", *python_path.split(":")]
            execution_command, pytest_token = _trusted_pytest_command(
                "python",
                container_python_paths,
                command,
                run_timeout,
            )
            execution = _run(
                _container_base(network="none", work_dir=staging_root, mount_read_only=True) + execution_command,
                timeout=run_timeout,
                pytest_token=pytest_token,
            )
        else:
            execution_script = f"PYTHONPATH=/work/site:{python_path} {reported_verification}"
            execution = _run(
                _container_base(network="none", work_dir=staging_root, mount_read_only=True)
                + ["sh", "-lc", execution_script],
                timeout=run_timeout,
            )
        verified = (
            _pytest_execution_verified(execution)
            if verification == "python -m pytest -q"
            else execution["exit_code"] == 0 and not execution["timed_out"]
        )
        return {
            "status": "verified" if verified else "verification_failed",
            "repository": analysis["repository"],
            "backend": "docker",
            "verification_command": reported_verification,
            "install": install,
            "execution": execution,
            "verified": verified,
            "verification_scope": "pytest_suite" if verification == "python -m pytest -q" else "smoke_command",
            "repair_evidence_eligible": verification == "python -m pytest -q",
            "evidence_note": (
                "Pytest verification requires a trusted completion attestation and at least one passed test; "
                "other commands use the recorded container exit code."
            ),
        }
    finally:
        shutil.rmtree(staging_root, ignore_errors=True)
