import json
from pathlib import Path

from repo_rescue.analysis import analyze_snapshot
from repo_rescue.orchestrator import copied_local_repository, run_builtin_demo, run_repair_loop
from repo_rescue.repair import DeterministicDemoRepairAgent


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
