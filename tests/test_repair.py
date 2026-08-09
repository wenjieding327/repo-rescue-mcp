import sys
from types import SimpleNamespace
from pathlib import Path

import pytest

from repo_rescue.repair import (
    FileReplacement,
    OpenAIRepairAgent,
    RepairProposal,
    apply_repair_proposal,
    parse_repair_proposal,
)
from repo_rescue.repository import RepositorySnapshot, inventory
from repo_rescue.security import SecurityError


def test_parses_json_repair_proposal() -> None:
    proposal = parse_repair_proposal(
        '```json\n{"analysis":"wrong operator","changes":[{"path":"app.py","content":"print(2)\\n"}]}\n```'
    )

    assert proposal.analysis == "wrong operator"
    assert proposal.changes[0].path == "app.py"


def test_applies_bounded_source_replacement(tmp_path: Path) -> None:
    target = tmp_path / "app.py"
    target.write_text("print(1)\n", encoding="utf-8")
    proposal = RepairProposal("fix output", (FileReplacement("app.py", "print(2)\n"),))

    applied = apply_repair_proposal(tmp_path, proposal)

    assert target.read_text(encoding="utf-8") == "print(2)\n"
    assert applied[0]["path"] == "app.py"
    assert applied[0]["before_sha256"] != applied[0]["after_sha256"]


def test_rejects_path_traversal(tmp_path: Path) -> None:
    (tmp_path / "app.py").write_text("print(1)\n", encoding="utf-8")
    proposal = RepairProposal("escape", (FileReplacement("../escape.py", "print(2)\n"),))

    with pytest.raises(SecurityError):
        apply_repair_proposal(tmp_path, proposal)


def test_rejects_test_modification(tmp_path: Path) -> None:
    tests = tmp_path / "tests"
    tests.mkdir()
    (tests / "test_app.py").write_text("assert False\n", encoding="utf-8")
    proposal = RepairProposal("weaken test", (FileReplacement("tests/test_app.py", "assert True\n"),))

    with pytest.raises(SecurityError, match="may not modify tests"):
        apply_repair_proposal(tmp_path, proposal)


def test_openai_agent_uses_responses_api_and_parses_result(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    (tmp_path / "app.py").write_text("def answer():\n    return 1\n", encoding="utf-8")
    total, files = inventory(tmp_path)
    snapshot = RepositorySnapshot(tmp_path, "demo/app", "https://github.com/demo/app", "abc", total, files)
    recorded: dict[str, object] = {}

    class FakeResponses:
        def create(self, **kwargs: object) -> object:
            recorded.update(kwargs)
            return SimpleNamespace(
                output_text='{"analysis":"wrong value","changes":[{"path":"app.py","content":"def answer():\\n    return 2\\n"}]}'
            )

    fake_module = SimpleNamespace(OpenAI=lambda: SimpleNamespace(responses=FakeResponses()))
    monkeypatch.setitem(sys.modules, "openai", fake_module)

    proposal = OpenAIRepairAgent(model="test-model").propose(
        snapshot,
        issue="answer should be two",
        verification={"execution": {"exit_code": 1, "stderr": "app.py:2: assertion failed"}},
        attempt=1,
    )

    assert recorded["model"] == "test-model"
    assert recorded["max_output_tokens"] == 20_000
    assert proposal.changes[0].content.endswith("return 2\n")
