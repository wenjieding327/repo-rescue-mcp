from contextlib import contextmanager
from pathlib import Path

import pytest

from repo_rescue.analysis import analyze_snapshot
from repo_rescue.bridge import (
    SubmittedRepairAgent,
    baseline_sha256,
    prepare_repair,
    proposal_from_changes,
    verify_submitted_github_patch,
)
from repo_rescue.orchestrator import copied_local_repository, run_repair_loop
from repo_rescue.repository import RepositorySnapshot
from repo_rescue.security import SecurityError
from repo_rescue.verifier import EphemeralVenvVerifier


def test_submitted_host_agent_patch_runs_the_real_verifier(tmp_path: Path) -> None:
    source = Path(__file__).resolve().parents[1] / "src" / "repo_rescue" / "demo_project"
    proposal = proposal_from_changes(
        "divide uses the wrong operator",
        [
            {
                "path": "calculator.py",
                "content": "def divide(a, b):\n    return a / b\n",
            }
        ],
    )

    with copied_local_repository(source) as snapshot:
        report = run_repair_loop(
            snapshot,
            analyze_snapshot(snapshot),
            issue="division is incorrect",
            agent=SubmittedRepairAgent(proposal),
            verifier=EphemeralVenvVerifier(tmp_path / "environment"),
            artifacts_root=tmp_path / "artifacts",
            max_attempts=1,
        )

    assert report["repair_agent"] == "host-agent-submitted-proposal"
    assert report["verified_repair"] is True
    assert report["baseline"]["execution"]["exit_code"] != 0
    assert report["final_verification"]["execution"]["exit_code"] == 0


def test_proposal_requires_complete_string_changes() -> None:
    with pytest.raises(ValueError, match="At least one"):
        proposal_from_changes("none", [])
    with pytest.raises(ValueError, match="string path"):
        proposal_from_changes("bad", [{"path": "app.py", "content": None}])  # type: ignore[list-item]
    with pytest.raises(ValueError, match="at most 8"):
        proposal_from_changes(
            "too many",
            [{"path": f"file-{index}.py", "content": "print('x')\n"} for index in range(9)],
        )


def test_proposal_path_is_still_checked_by_patch_boundary(tmp_path: Path) -> None:
    source = Path(__file__).resolve().parents[1] / "src" / "repo_rescue" / "demo_project"
    proposal = proposal_from_changes(
        "attempt traversal",
        [{"path": "../outside.py", "content": "print('no')\n"}],
    )
    with copied_local_repository(source) as snapshot:
        report = run_repair_loop(
            snapshot,
            analyze_snapshot(snapshot),
            issue="bad proposal",
            agent=SubmittedRepairAgent(proposal),
            verifier=EphemeralVenvVerifier(tmp_path / "environment"),
            artifacts_root=tmp_path / "artifacts",
            max_attempts=1,
        )

    assert report["verified_repair"] is False
    assert report["status"] == "repair_agent_failed"
    assert report["attempts"][0]["error_type"] == SecurityError.__name__


def test_prepare_rejects_unlisted_repository_before_network(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("REPO_RESCUE_ALLOWED_REPOS", raising=False)

    with pytest.raises(SecurityError, match="explicitly added"):
        prepare_repair("https://github.com/example/project")


def test_verify_rejects_invalid_commit_before_clone(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("REPO_RESCUE_ALLOWED_REPOS", "example/project")

    with pytest.raises(SecurityError, match="40-character SHA"):
        verify_submitted_github_patch(
            "https://github.com/example/project",
            expected_commit="main",
            expected_baseline_sha256="0" * 64,
            analysis="bad commit",
            changes=[{"path": "app.py", "content": "print('ok')\n"}],
            issue="",
            artifacts_root=tmp_path / "artifacts",
        )


def test_prepare_and_verify_are_bound_to_the_same_baseline(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    source = Path(__file__).resolve().parents[1] / "src" / "repo_rescue" / "demo_project"
    monkeypatch.setenv("REPO_RESCUE_ALLOWED_REPOS", "example/project")

    @contextmanager
    def fake_clone(repo_url):  # type: ignore[no-untyped-def]
        with copied_local_repository(source, slug="example/project") as snapshot:
            yield RepositorySnapshot(
                snapshot.path,
                snapshot.slug,
                "https://github.com/example/project",
                "a" * 40,
                snapshot.total_bytes,
                snapshot.files,
            )

    monkeypatch.setattr("repo_rescue.bridge.clone_public_repository", fake_clone)
    preparation = prepare_repair(
        "https://github.com/example/project",
        verifier=EphemeralVenvVerifier(tmp_path / "prepare-environment"),
    )

    report = verify_submitted_github_patch(
        "https://github.com/example/project",
        expected_commit=preparation["repository"]["commit"],
        expected_baseline_sha256=preparation["baseline_sha256"],
        analysis="replace multiplication with division",
        changes=[{"path": "calculator.py", "content": "def divide(a, b):\n    return a / b\n"}],
        issue="division is wrong",
        artifacts_root=tmp_path / "artifacts",
        verifier=EphemeralVenvVerifier(tmp_path / "verify-environment"),
    )

    assert report["verified_repair"] is True
    assert report["baseline"]["preparation_baseline_sha256"] == preparation["baseline_sha256"]


def test_verify_rejects_baseline_drift(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    source = Path(__file__).resolve().parents[1] / "src" / "repo_rescue" / "demo_project"
    monkeypatch.setenv("REPO_RESCUE_ALLOWED_REPOS", "example/project")

    @contextmanager
    def fake_clone(repo_url):  # type: ignore[no-untyped-def]
        with copied_local_repository(source, slug="example/project") as snapshot:
            yield RepositorySnapshot(
                snapshot.path,
                snapshot.slug,
                "https://github.com/example/project",
                "b" * 40,
                snapshot.total_bytes,
                snapshot.files,
            )

    monkeypatch.setattr("repo_rescue.bridge.clone_public_repository", fake_clone)

    with pytest.raises(SecurityError, match="Baseline evidence changed"):
        verify_submitted_github_patch(
            "https://github.com/example/project",
            expected_commit="b" * 40,
            expected_baseline_sha256="0" * 64,
            analysis="stale preparation",
            changes=[{"path": "calculator.py", "content": "def divide(a, b):\n    return a / b\n"}],
            issue="division is wrong",
            artifacts_root=tmp_path / "artifacts",
            verifier=EphemeralVenvVerifier(tmp_path / "verify-environment"),
        )


def test_baseline_hash_ignores_successful_install_cache_chatter() -> None:
    common = {
        "status": "verification_failed",
        "backend": "docker",
        "command": "python -m pytest -q",
        "execution": {
            "exit_code": 1,
            "timed_out": False,
            "stdout": "",
            "stderr": "tests/test_app.py:4: AssertionError\n1 failed in 0.12s",
        },
    }
    first = {**common, "install": {"exit_code": 0, "timed_out": False, "stdout": "Downloading demo.whl"}}
    second = {**common, "install": {"exit_code": 0, "timed_out": False, "stdout": "Using cached demo.whl"}}

    assert baseline_sha256("a" * 40, first) == baseline_sha256("a" * 40, second)


def test_baseline_hash_detects_changed_dependency_failure() -> None:
    first = {
        "status": "dependency_install_failed",
        "backend": "docker",
        "command": "python -m pytest -q",
        "install": {"exit_code": 1, "timed_out": False, "stderr": "No matching distribution for demo==1"},
        "execution": None,
    }
    second = {
        **first,
        "install": {"exit_code": 1, "timed_out": False, "stderr": "No matching distribution for other==1"},
    }

    assert baseline_sha256("a" * 40, first) != baseline_sha256("a" * 40, second)
