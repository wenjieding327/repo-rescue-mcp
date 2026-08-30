import json
from pathlib import Path

import pytest

from repo_rescue.analysis import analyze_snapshot
from repo_rescue.orchestrator import _exit_code, copied_local_repository, run_builtin_demo, run_github_repair, run_repair_loop
from repo_rescue.repair import DeterministicDemoRepairAgent, FileReplacement, RepairProposal
from repo_rescue.security import SecurityError


def test_builtin_demo_runs_complete_repair_loop(tmp_path: Path) -> None:
    report = run_builtin_demo(artifacts_root=tmp_path / "artifacts")

    assert report["status"] == "verified_repair"
    assert report["verified_repair"] is True
    assert report["baseline"]["execution"]["exit_code"] != 0
    assert report["final_verification"]["execution"]["exit_code"] == 0
    assert report["baseline"]["command"] == report["final_verification"]["command"]
    assert report["changed_files"] == ["calculator.py"]

    patch = Path(report["artifacts"]["patch"])
    evidence = Path(report["artifacts"]["evidence"])
    markdown = Path(report["artifacts"]["report"])
    assert "-    return a * b" in patch.read_text(encoding="utf-8")
    assert "+    return a / b" in patch.read_text(encoding="utf-8")
    assert json.loads(evidence.read_text(encoding="utf-8"))["verified_repair"] is True
    assert str(tmp_path) not in evidence.read_text(encoding="utf-8")
    assert report["repository"]["url"] == "builtin://interview-demo"
    assert "repo-rescue-local-" not in evidence.read_text(encoding="utf-8")
    assert "VERIFIED REPAIR" in markdown.read_text(encoding="utf-8")


def test_already_passing_repository_is_not_called_a_repair(tmp_path: Path) -> None:
    source = Path(__file__).resolve().parents[1] / "src" / "repo_rescue" / "demo_project"

    class PassingVerifier:
        command = "python -m unittest discover -s tests -v"

        def verify(self, snapshot, analysis):  # type: ignore[no-untyped-def]
            return {
                "status": "verified",
                "verified": True,
                "backend": "test",
                "command": self.command,
                "execution": {"exit_code": 0, "timed_out": False, "stdout": "", "stderr": ""},
            }

    with copied_local_repository(source) as snapshot:
        report = run_repair_loop(
            snapshot,
            analyze_snapshot(snapshot),
            issue="none",
            agent=DeterministicDemoRepairAgent(),
            verifier=PassingVerifier(),
            artifacts_root=tmp_path / "artifacts",
            max_attempts=1,
        )

    assert report["status"] == "already_passing"
    assert report["verified_repair"] is False
    assert report["attempts"] == []


def test_repairs_dependency_install_failure_with_manifest_change(tmp_path: Path) -> None:
    source = tmp_path / "project"
    source.mkdir()
    (source / "requirements.txt").write_text("demopkg==0\n", encoding="utf-8")
    (source / "main.py").write_text("print('ok')\n", encoding="utf-8")

    class ManifestRepairAgent:
        name = "manifest-repair"

        def propose(self, snapshot, *, issue, verification, attempt):  # type: ignore[no-untyped-def]
            assert verification["status"] == "dependency_install_failed"
            return RepairProposal(
                "replace the broken dependency entry",
                (
                    FileReplacement("requirements.txt", "demopkg==1\n"),
                ),
            )

    class DependencyVerifier:
        command = "python -m pytest -q"

        def __init__(self) -> None:
            self.calls: list[list[str]] = []

        def verify(self, snapshot, analysis):  # type: ignore[no-untyped-def]
            dependencies = list(analysis.get("execution_dependencies", []))
            self.calls.append(dependencies)
            install_exit = 1 if "demopkg==0" in dependencies else 0
            return {
                "status": "dependency_install_failed" if install_exit else "verified",
                "verified": install_exit == 0,
                "backend": "test",
                "command": self.command,
                "install": {"exit_code": install_exit, "timed_out": False, "stdout": "", "stderr": ""},
                "execution": None if install_exit else {"exit_code": 0, "timed_out": False, "stdout": "", "stderr": ""},
            }

    verifier = DependencyVerifier()
    with copied_local_repository(source, slug="student/dependency-demo") as snapshot:
        report = run_repair_loop(
            snapshot,
            analyze_snapshot(snapshot),
            issue="dependency install fails",
            agent=ManifestRepairAgent(),
            verifier=verifier,
            artifacts_root=tmp_path / "artifacts",
            max_attempts=1,
        )

    assert report["status"] == "verified_repair"
    assert report["verified_repair"] is True
    assert report["changed_files"] == ["requirements.txt"]
    assert verifier.calls == [["demopkg==0"], ["demopkg==1"]]
    assert report["baseline"]["install"]["exit_code"] == 1
    assert report["final_verification"]["install"]["exit_code"] == 0


def test_blocks_unapproved_new_dependency_distribution(tmp_path: Path) -> None:
    source = tmp_path / "project"
    source.mkdir()
    (source / "requirements.txt").write_text("demopkg==0\n", encoding="utf-8")
    (source / "main.py").write_text("print('ok')\n", encoding="utf-8")

    class NewDependencyAgent:
        name = "new-dependency"

        def propose(self, snapshot, *, issue, verification, attempt):  # type: ignore[no-untyped-def]
            return RepairProposal(
                "add a new distribution",
                (FileReplacement("requirements.txt", "demopkg==0\nuntrusted-plugin==1\n"),),
            )

    class FailingVerifier:
        command = "python -m pytest -q"

        def __init__(self) -> None:
            self.calls = 0

        def verify(self, snapshot, analysis):  # type: ignore[no-untyped-def]
            self.calls += 1
            return {
                "status": "dependency_install_failed",
                "verified": False,
                "backend": "test",
                "command": self.command,
                "install": {"exit_code": 1, "timed_out": False, "stdout": "", "stderr": "failed"},
                "execution": None,
            }

    verifier = FailingVerifier()
    with copied_local_repository(source, slug="student/dependency-demo") as snapshot:
        report = run_repair_loop(
            snapshot,
            analyze_snapshot(snapshot),
            issue="dependency install fails",
            agent=NewDependencyAgent(),
            verifier=verifier,
            artifacts_root=tmp_path / "artifacts",
            max_attempts=1,
        )

    assert report["status"] == "repair_agent_failed"
    assert report["verified_repair"] is False
    assert report["attempts"][0]["error_type"] == "SecurityError"
    assert "untrusted-plugin" in report["attempts"][0]["error"]
    assert verifier.calls == 1


def test_exit_code_falls_back_to_install_failure() -> None:
    assert _exit_code({"execution": None, "install": {"exit_code": 1}}) == 1
    assert _exit_code({"execution": {}, "install": {"exit_code": 2}}) == 2


def test_net_zero_patch_cannot_keep_verified_repair_status(tmp_path: Path) -> None:
    source = tmp_path / "project"
    source.mkdir()
    (source / "app.py").write_text("VALUE = 'A'\n", encoding="utf-8")

    class RevertingAgent:
        name = "reverting-agent"

        def propose(self, snapshot, *, issue, verification, attempt):  # type: ignore[no-untyped-def]
            content = "VALUE = 'B'\n" if attempt == 1 else "VALUE = 'A'\n"
            return RepairProposal("change then revert", (FileReplacement("app.py", content),))

    class FinalCallPassingVerifier:
        command = "python -m pytest -q"

        def __init__(self) -> None:
            self.calls = 0

        def verify(self, snapshot, analysis):  # type: ignore[no-untyped-def]
            self.calls += 1
            passed = self.calls == 3
            return {
                "status": "verified" if passed else "verification_failed",
                "verified": passed,
                "backend": "test",
                "command": self.command,
                "execution": {"exit_code": 0 if passed else 1, "timed_out": False, "stdout": "", "stderr": ""},
            }

    with copied_local_repository(source) as snapshot:
        report = run_repair_loop(
            snapshot,
            analyze_snapshot(snapshot),
            issue="test",
            agent=RevertingAgent(),
            verifier=FinalCallPassingVerifier(),
            artifacts_root=tmp_path / "artifacts",
            max_attempts=2,
        )

    assert report["status"] == "repair_failed"
    assert report["verified_repair"] is False
    assert report["changed_files"] == ["app.py"]
    assert Path(report["artifacts"]["patch"]).read_text(encoding="utf-8") == ""
    assert "REPAIR_FAILED" in Path(report["artifacts"]["report"]).read_text(encoding="utf-8")


def test_smoke_only_command_cannot_produce_verified_repair(tmp_path: Path) -> None:
    source = tmp_path / "project"
    source.mkdir()
    (source / "app.py").write_text("raise RuntimeError('broken')\n", encoding="utf-8")

    class SmokeAgent:
        name = "smoke-agent"

        def propose(self, snapshot, *, issue, verification, attempt):  # type: ignore[no-untyped-def]
            return RepairProposal("make the file run", (FileReplacement("app.py", "print('runs')\n"),))

    class SmokeVerifier:
        command = "python -m compileall -q ."

        def __init__(self) -> None:
            self.calls = 0

        def verify(self, snapshot, analysis):  # type: ignore[no-untyped-def]
            self.calls += 1
            passed = self.calls > 1
            return {
                "status": "verified" if passed else "verification_failed",
                "verified": passed,
                "backend": "test",
                "command": self.command,
                "repair_evidence_eligible": False,
                "verification_scope": "smoke_command",
                "execution": {"exit_code": 0 if passed else 1, "timed_out": False, "stdout": "", "stderr": ""},
            }

    with copied_local_repository(source) as snapshot:
        report = run_repair_loop(
            snapshot,
            analyze_snapshot(snapshot),
            issue="runtime failure",
            agent=SmokeAgent(),
            verifier=SmokeVerifier(),
            artifacts_root=tmp_path / "artifacts",
            max_attempts=1,
        )

    assert report["status"] == "repair_smoke_passed"
    assert report["verified_repair"] is False


def test_repair_cannot_reduce_pytest_coverage_or_add_skips(tmp_path: Path) -> None:
    source = tmp_path / "project"
    source.mkdir()
    (source / "app.py").write_text("VALUE = 1\n", encoding="utf-8")

    class Agent:
        name = "coverage-weakener"

        def propose(self, snapshot, *, issue, verification, attempt):  # type: ignore[no-untyped-def]
            return RepairProposal("change behavior", (FileReplacement("app.py", "VALUE = 2\n"),))

    class Verifier:
        command = "python -m pytest -q"

        def __init__(self) -> None:
            self.calls = 0

        def verify(self, snapshot, analysis):  # type: ignore[no-untyped-def]
            self.calls += 1
            baseline = self.calls == 1
            return {
                "status": "verification_failed" if baseline else "verified",
                "verified": not baseline,
                "backend": "test",
                "command": self.command,
                "execution": {
                    "exit_code": 1 if baseline else 0,
                    "timed_out": False,
                    "stdout": "",
                    "stderr": "",
                    "pytest_attestation": {
                        "completed": True,
                        "collected": 3 if baseline else 2,
                        "passed": 2 if baseline else 1,
                        "failed": 1 if baseline else 0,
                        "skipped": 0 if baseline else 1,
                        "errors": 0,
                        "runner_exit_code": 1 if baseline else 0,
                    },
                },
            }

    with copied_local_repository(source) as snapshot:
        report = run_repair_loop(
            snapshot,
            analyze_snapshot(snapshot),
            issue="failure",
            agent=Agent(),
            verifier=Verifier(),
            artifacts_root=tmp_path / "artifacts",
            max_attempts=1,
        )

    assert report["status"] == "repair_agent_failed"
    assert report["verified_repair"] is False
    assert "fewer tests" in report["attempts"][0]["error"]


def test_dependency_failure_baseline_cannot_be_repaired_by_skipping_tests(tmp_path: Path) -> None:
    source = tmp_path / "project"
    source.mkdir()
    (source / "requirements.txt").write_text("demopkg==0\n", encoding="utf-8")
    (source / "app.py").write_text("VALUE = 1\n", encoding="utf-8")
    tests = source / "tests"
    tests.mkdir()
    (tests / "test_app.py").write_text("def test_value(): assert False\n", encoding="utf-8")

    class Agent:
        name = "skip-inducing-agent"

        def propose(self, snapshot, *, issue, verification, attempt):  # type: ignore[no-untyped-def]
            return RepairProposal("change behavior", (FileReplacement("app.py", "VALUE = 2\n"),))

    class Verifier:
        command = "python -m pytest -q"

        def __init__(self) -> None:
            self.calls = 0

        def verify(self, snapshot, analysis):  # type: ignore[no-untyped-def]
            self.calls += 1
            if self.calls == 1:
                return {
                    "status": "dependency_install_failed",
                    "verified": False,
                    "backend": "test",
                    "command": self.command,
                    "verification_scope": "pytest_suite",
                    "execution": None,
                }
            return {
                "status": "verified",
                "verified": True,
                "backend": "test",
                "command": self.command,
                "verification_scope": "pytest_suite",
                "execution": {
                    "exit_code": 0,
                    "timed_out": False,
                    "stdout": "",
                    "stderr": "",
                    "pytest_attestation": {
                        "completed": True,
                        "collected": 100,
                        "passed": 1,
                        "failed": 0,
                        "skipped": 99,
                        "errors": 0,
                        "runner_exit_code": 0,
                    },
                },
            }

    with copied_local_repository(source) as snapshot:
        report = run_repair_loop(
            snapshot,
            analyze_snapshot(snapshot),
            issue="dependency failure",
            agent=Agent(),
            verifier=Verifier(),
            artifacts_root=tmp_path / "artifacts",
            max_attempts=1,
        )

    assert report["status"] == "repair_agent_failed"
    assert report["verified_repair"] is False
    assert "skipped tests cannot be verified" in report["attempts"][0]["error"]


def test_repair_must_collect_at_least_the_initial_static_test_modules(tmp_path: Path) -> None:
    source = tmp_path / "project"
    source.mkdir()
    (source / "app.py").write_text("VALUE = 1\n", encoding="utf-8")
    tests = source / "tests"
    tests.mkdir()
    (tests / "test_one.py").write_text("def test_one(): assert False\n", encoding="utf-8")
    (tests / "test_two.py").write_text("def test_two(): assert False\n", encoding="utf-8")

    class Agent:
        name = "collection-reducer"

        def propose(self, snapshot, *, issue, verification, attempt):  # type: ignore[no-untyped-def]
            return RepairProposal("change behavior", (FileReplacement("app.py", "VALUE = 2\n"),))

    class Verifier:
        command = "python -m pytest -q"

        def __init__(self) -> None:
            self.calls = 0

        def verify(self, snapshot, analysis):  # type: ignore[no-untyped-def]
            self.calls += 1
            if self.calls == 1:
                return {
                    "status": "dependency_install_failed",
                    "verified": False,
                    "backend": "test",
                    "command": self.command,
                    "verification_scope": "pytest_suite",
                    "execution": None,
                }
            return {
                "status": "verified",
                "verified": True,
                "backend": "test",
                "command": self.command,
                "verification_scope": "pytest_suite",
                "execution": {
                    "exit_code": 0,
                    "timed_out": False,
                    "stdout": "",
                    "stderr": "",
                    "pytest_attestation": {
                        "completed": True,
                        "collected": 1,
                        "passed": 1,
                        "failed": 0,
                        "skipped": 0,
                        "errors": 0,
                        "runner_exit_code": 0,
                    },
                },
            }

    with copied_local_repository(source) as snapshot:
        report = run_repair_loop(
            snapshot,
            analyze_snapshot(snapshot),
            issue="dependency failure",
            agent=Agent(),
            verifier=Verifier(),
            artifacts_root=tmp_path / "artifacts",
            max_attempts=1,
        )

    assert report["status"] == "repair_agent_failed"
    assert report["verified_repair"] is False
    assert "initial static test modules" in report["attempts"][0]["error"]


def test_dependency_failure_without_baseline_coverage_is_not_a_verified_repair(tmp_path: Path) -> None:
    source = tmp_path / "project"
    source.mkdir()
    (source / "requirements.txt").write_text("demopkg==0\n", encoding="utf-8")
    tests = source / "tests"
    tests.mkdir()
    (tests / "test_app.py").write_text("def test_value(): assert True\n", encoding="utf-8")

    class Agent:
        name = "manifest-repair"

        def propose(self, snapshot, *, issue, verification, attempt):  # type: ignore[no-untyped-def]
            return RepairProposal(
                "fix the dependency version",
                (FileReplacement("requirements.txt", "demopkg==1\n"),),
            )

    class Verifier:
        command = "python -m pytest -q"

        def __init__(self) -> None:
            self.calls = 0

        def verify(self, snapshot, analysis):  # type: ignore[no-untyped-def]
            self.calls += 1
            if self.calls == 1:
                return {
                    "status": "dependency_install_failed",
                    "verified": False,
                    "backend": "test",
                    "command": self.command,
                    "verification_scope": "pytest_suite",
                    "execution": None,
                }
            return {
                "status": "verified",
                "verified": True,
                "backend": "test",
                "command": self.command,
                "verification_scope": "pytest_suite",
                "execution": {
                    "exit_code": 0,
                    "timed_out": False,
                    "stdout": "",
                    "stderr": "",
                    "pytest_attestation": {
                        "completed": True,
                        "collected": 1,
                        "passed": 1,
                        "failed": 0,
                        "skipped": 0,
                        "errors": 0,
                        "runner_exit_code": 0,
                    },
                },
            }

    with copied_local_repository(source) as snapshot:
        report = run_repair_loop(
            snapshot,
            analyze_snapshot(snapshot),
            issue="dependency failure",
            agent=Agent(),
            verifier=Verifier(),
            artifacts_root=tmp_path / "artifacts",
            max_attempts=1,
        )

    assert report["status"] == "repair_tests_passed_uncompared"
    assert report["verified_repair"] is False
    assert report["final_verification"]["verified"] is True


def test_github_repair_checks_allowlist_before_clone(tmp_path: Path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    monkeypatch.delenv("REPO_RESCUE_ALLOWED_REPOS", raising=False)

    def unexpected_clone(repo_url):  # type: ignore[no-untyped-def]
        raise AssertionError("clone must not run before execution authorization")

    monkeypatch.setattr("repo_rescue.orchestrator.clone_public_repository", unexpected_clone)

    with pytest.raises(SecurityError, match="explicitly added"):
        run_github_repair(
            "https://github.com/example/project",
            artifacts_root=tmp_path / "artifacts",
        )
