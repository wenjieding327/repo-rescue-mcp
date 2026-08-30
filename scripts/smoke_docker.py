from __future__ import annotations

import hashlib
import os
import tempfile
from pathlib import Path

from repo_rescue.analysis import analyze_snapshot
from repo_rescue.orchestrator import run_repair_loop
from repo_rescue.repair import DeterministicDemoRepairAgent
from repo_rescue.repository import RepositorySnapshot, inventory
from repo_rescue.verifier import DockerRepositoryVerifier


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="repo-rescue-docker-smoke-") as temporary:
        root = Path(temporary)
        project = root / "project"
        tests = project / "tests"
        tests.mkdir(parents=True)
        (project / "calculator.py").write_text(
            "def divide(a, b):\n    return a * b\n",
            encoding="utf-8",
        )
        (tests / "test_calculator.py").write_text(
            "from calculator import divide\n\ndef test_divide():\n    assert divide(8, 2) == 4\n",
            encoding="utf-8",
        )
        total, files = inventory(project)
        commit = hashlib.sha256(
            b"".join(relative.encode("utf-8") + b"\0" + (project / relative).read_bytes() for relative in files)
        ).hexdigest()
        snapshot = RepositorySnapshot(
            path=project,
            slug="fixture/docker-smoke",
            source_url="builtin://docker-smoke",
            commit=commit,
            total_bytes=total,
            files=files,
        )
        previous_allowlist = os.environ.get("REPO_RESCUE_ALLOWED_REPOS")
        previous_backend = os.environ.get("REPO_RESCUE_EXECUTION_BACKEND")
        os.environ["REPO_RESCUE_ALLOWED_REPOS"] = snapshot.slug
        os.environ["REPO_RESCUE_EXECUTION_BACKEND"] = "docker"
        try:
            report = run_repair_loop(
                snapshot,
                analyze_snapshot(snapshot),
                issue="The divide function returns the wrong result.",
                agent=DeterministicDemoRepairAgent(),
                verifier=DockerRepositoryVerifier(),
                artifacts_root=root / "artifacts",
                max_attempts=1,
            )
        finally:
            if previous_allowlist is None:
                os.environ.pop("REPO_RESCUE_ALLOWED_REPOS", None)
            else:
                os.environ["REPO_RESCUE_ALLOWED_REPOS"] = previous_allowlist
            if previous_backend is None:
                os.environ.pop("REPO_RESCUE_EXECUTION_BACKEND", None)
            else:
                os.environ["REPO_RESCUE_EXECUTION_BACKEND"] = previous_backend

        if report["status"] != "verified_repair" or not report["verified_repair"]:
            raise RuntimeError(f"Docker repair smoke did not verify: {report['status']}")
        if report["baseline"].get("backend") != "docker":
            raise RuntimeError("Docker repair smoke used the wrong verifier backend.")
        if report["baseline"]["execution"]["exit_code"] == 0:
            raise RuntimeError("Docker repair smoke baseline unexpectedly passed.")
        if report["final_verification"]["execution"]["exit_code"] != 0:
            raise RuntimeError("Docker repair smoke final verification failed.")
        patch = Path(report["artifacts"]["patch"]).read_text(encoding="utf-8")
        if "return a / b" not in patch:
            raise RuntimeError("Docker repair smoke did not emit the expected patch.")
        print(f"DOCKER_REPAIR_STATUS={report['status']}")
        print(f"DOCKER_BEFORE_EXIT={report['baseline']['execution']['exit_code']}")
        print(f"DOCKER_AFTER_EXIT={report['final_verification']['execution']['exit_code']}")
        print("DOCKER_PATCH_PRESENT=True")


if __name__ == "__main__":
    main()
