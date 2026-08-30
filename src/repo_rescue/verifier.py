from __future__ import annotations

import os
import subprocess
import time
import venv
from pathlib import Path
from typing import Any, Protocol

from .repository import RepositorySnapshot
from .runner import reproduce
from .security import redact_paths


class Verifier(Protocol):
    @property
    def command(self) -> str: ...

    def verify(self, snapshot: RepositorySnapshot, analysis: dict[str, Any]) -> dict[str, Any]: ...


class DockerRepositoryVerifier:
    @property
    def command(self) -> str:
        return "auto: repository analyzer fixed command"

    def verify(self, snapshot: RepositorySnapshot, analysis: dict[str, Any]) -> dict[str, Any]:
        result = reproduce(snapshot, analysis)
        return {
            "status": result.get("status"),
            "verified": bool(result.get("verified")),
            "backend": result.get("backend", "docker"),
            "command": result.get("verification_command"),
            "install": result.get("install"),
            "execution": result.get("execution"),
            "verification_scope": result.get("verification_scope"),
            "repair_evidence_eligible": result.get("repair_evidence_eligible"),
            "evidence_note": result.get("evidence_note"),
        }


class EphemeralVenvVerifier:
    """Dependency-free verifier for the bundled, trusted interview demo only."""

    def __init__(self, environment_root: Path, timeout_seconds: int = 30) -> None:
        self.environment_root = environment_root
        self.timeout_seconds = timeout_seconds
        self.venv_root = environment_root / "verification-venv"
        self._python: Path | None = None

    @property
    def command(self) -> str:
        return "python -m unittest discover -s tests -v"

    def _ensure_environment(self) -> Path:
        if self._python is not None:
            return self._python
        venv.EnvBuilder(with_pip=False, clear=True).create(self.venv_root)
        python = self.venv_root / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
        if not python.is_file():
            raise RuntimeError("Unable to create the ephemeral Python verification environment.")
        self._python = python
        return python

    def verify(self, snapshot: RepositorySnapshot, analysis: dict[str, Any]) -> dict[str, Any]:
        python = self._ensure_environment()
        command = [str(python), "-m", "unittest", "discover", "-s", "tests", "-v"]
        environment = {
            "PATH": str(python.parent),
            "HOME": str(self.environment_root),
            "TMPDIR": str(self.environment_root),
            "PYTHONDONTWRITEBYTECODE": "1",
        }
        if os.environ.get("SYSTEMROOT"):
            environment["SYSTEMROOT"] = os.environ["SYSTEMROOT"]
        started = time.monotonic()
        try:
            result = subprocess.run(
                command,
                cwd=snapshot.path,
                env=environment,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=self.timeout_seconds,
                check=False,
            )
            execution = {
                "command": self.command,
                "exit_code": result.returncode,
                "timed_out": False,
                "duration_seconds": round(time.monotonic() - started, 3),
                "stdout": redact_paths(
                    result.stdout or "",
                    [(snapshot.path, "<repository>"), (self.environment_root, "<environment>")],
                ),
                "stderr": redact_paths(
                    result.stderr or "",
                    [(snapshot.path, "<repository>"), (self.environment_root, "<environment>")],
                ),
            }
        except subprocess.TimeoutExpired as exc:
            execution = {
                "command": self.command,
                "exit_code": None,
                "timed_out": True,
                "duration_seconds": round(time.monotonic() - started, 3),
                "stdout": redact_paths(
                    exc.stdout or "",
                    [(snapshot.path, "<repository>"), (self.environment_root, "<environment>")],
                ),
                "stderr": redact_paths(
                    exc.stderr or "",
                    [(snapshot.path, "<repository>"), (self.environment_root, "<environment>")],
                ),
            }
        verified = execution["exit_code"] == 0 and not execution["timed_out"]
        return {
            "status": "verified" if verified else "verification_failed",
            "verified": verified,
            "backend": "ephemeral_venv_trusted_demo",
            "command": self.command,
            "install": {
                "exit_code": 0,
                "timed_out": False,
                "duration_seconds": 0.0,
                "stdout": "Standard-library demo; no packages installed.",
                "stderr": "",
            },
            "execution": execution,
            "evidence_note": (
                "The bundled trusted demo ran in a newly created ephemeral virtual environment. "
                "Untrusted GitHub repositories use the Docker verifier instead."
            ),
        }
