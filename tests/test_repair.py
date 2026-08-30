import os
import sys
from types import SimpleNamespace
from pathlib import Path

import pytest

from repo_rescue.repair import (
    FileReplacement,
    OpenAIRepairAgent,
    RepairProposal,
    apply_repair_proposal,
    collect_repair_context,
    parse_repair_proposal,
)
from repo_rescue.repository import RepositorySnapshot, inventory
from repo_rescue.security import SecurityError


def _snapshot(root: Path) -> RepositorySnapshot:
    total, files = inventory(root)
    return RepositorySnapshot(root, "demo/app", "https://github.com/demo/app", "abc", total, files)


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

    applied = apply_repair_proposal(_snapshot(tmp_path), proposal)

    assert target.read_text(encoding="utf-8") == "print(2)\n"
    assert applied[0]["path"] == "app.py"
    assert applied[0]["before_sha256"] != applied[0]["after_sha256"]


def test_rejects_path_traversal(tmp_path: Path) -> None:
    (tmp_path / "app.py").write_text("print(1)\n", encoding="utf-8")
    proposal = RepairProposal("escape", (FileReplacement("../escape.py", "print(2)\n"),))

    with pytest.raises(SecurityError):
        apply_repair_proposal(_snapshot(tmp_path), proposal)


def test_rejects_symlink_alias_to_test_file(tmp_path: Path) -> None:
    tests = tmp_path / "tests"
    tests.mkdir()
    (tests / "helper.py").write_text("EXPECTED = 1\n", encoding="utf-8")
    alias = tmp_path / "src_alias.py"
    try:
        alias.symlink_to(tests / "helper.py")
    except OSError as exc:
        pytest.skip(f"symlink creation is unavailable: {exc}")

    proposal = RepairProposal("change helper via alias", (FileReplacement("src_alias.py", "EXPECTED = 2\n"),))

    with pytest.raises(SecurityError, match="initial repository snapshot"):
        apply_repair_proposal(_snapshot(tmp_path), proposal)
    assert (tests / "helper.py").read_text(encoding="utf-8") == "EXPECTED = 1\n"


def test_rejects_case_variant_that_is_not_an_exact_inventory_path(tmp_path: Path) -> None:
    target = tmp_path / "ApplicationSource.py"
    target.write_text("VALUE = 1\n", encoding="utf-8")
    snapshot = _snapshot(tmp_path)
    proposal = RepairProposal(
        "use a filesystem case alias",
        (FileReplacement("applicationsource.py", "VALUE = 2\n"),),
    )

    with pytest.raises(SecurityError, match="exact path from the initial repository snapshot"):
        apply_repair_proposal(snapshot, proposal)
    assert target.read_text(encoding="utf-8") == "VALUE = 1\n"


@pytest.mark.skipif(os.name != "nt", reason="NTFS 8.3 aliases are Windows-specific")
def test_rejects_windows_short_name_alias_not_present_in_inventory(tmp_path: Path) -> None:
    import ctypes

    test_root = tmp_path / "integration_tests"
    test_root.mkdir()
    target = test_root / "helpers.py"
    target.write_text("EXPECTED = 1\n", encoding="utf-8")
    buffer = ctypes.create_unicode_buffer(32_768)
    length = ctypes.windll.kernel32.GetShortPathNameW(str(test_root), buffer, len(buffer))
    if not length:
        pytest.skip("Windows did not expose an 8.3 path for the test file")
    short_directory = Path(buffer.value).name
    if short_directory.casefold() == test_root.name.casefold():
        pytest.skip("8.3 alias creation is disabled on this volume")
    proposal = RepairProposal(
        "modify a test helper through its short directory alias",
        (FileReplacement(f"{short_directory}/helpers.py", "EXPECTED = 2\n"),),
    )

    with pytest.raises(SecurityError, match="exact path from the initial repository snapshot"):
        apply_repair_proposal(_snapshot(tmp_path), proposal)
    assert target.read_text(encoding="utf-8") == "EXPECTED = 1\n"


@pytest.mark.parametrize("directory", ["integration_tests", "unit_tests", "testing", "spec", "specs"])
def test_rejects_helpers_anywhere_in_named_test_tree(tmp_path: Path, directory: str) -> None:
    test_root = tmp_path / directory
    test_root.mkdir()
    helper = test_root / "helpers.py"
    helper.write_text("EXPECTED = 1\n", encoding="utf-8")
    (test_root / "test_feature.py").write_text(
        "from .helpers import EXPECTED\n\ndef test_feature():\n    assert EXPECTED == 1\n",
        encoding="utf-8",
    )
    proposal = RepairProposal(
        "weaken a test helper",
        (FileReplacement(f"{directory}/helpers.py", "EXPECTED = 2\n"),),
    )

    with pytest.raises(SecurityError, match="may not modify tests"):
        apply_repair_proposal(_snapshot(tmp_path), proposal)
    assert helper.read_text(encoding="utf-8") == "EXPECTED = 1\n"


def test_protects_entire_directory_discovered_from_a_test_file(tmp_path: Path) -> None:
    qa = tmp_path / "qa"
    qa.mkdir()
    helper = qa / "expected_values.py"
    helper.write_text("EXPECTED = 1\n", encoding="utf-8")
    (qa / "test_feature.py").write_text("def test_feature():\n    assert True\n", encoding="utf-8")
    proposal = RepairProposal(
        "weaken helper in a custom test directory",
        (FileReplacement("qa/expected_values.py", "EXPECTED = 2\n"),),
    )

    with pytest.raises(SecurityError, match="may not modify tests"):
        apply_repair_proposal(_snapshot(tmp_path), proposal)
    assert helper.read_text(encoding="utf-8") == "EXPECTED = 1\n"


def test_rejects_test_modification(tmp_path: Path) -> None:
    tests = tmp_path / "tests"
    tests.mkdir()
    (tests / "test_app.py").write_text("assert False\n", encoding="utf-8")
    proposal = RepairProposal("weaken test", (FileReplacement("tests/test_app.py", "assert True\n"),))

    with pytest.raises(SecurityError, match="may not modify tests"):
        apply_repair_proposal(_snapshot(tmp_path), proposal)


def test_rejects_conftest_and_pyproject_test_configuration_changes(tmp_path: Path) -> None:
    (tmp_path / "conftest.py").write_text("# fixtures\n", encoding="utf-8")
    conftest = RepairProposal("skip tests", (FileReplacement("conftest.py", "collect_ignore = ['tests']\n"),))
    with pytest.raises(SecurityError, match="may not modify tests"):
        apply_repair_proposal(_snapshot(tmp_path), conftest)

    pyproject = tmp_path / "pyproject.toml"
    pyproject.write_text(
        "[project]\nname = 'demo'\ndependencies = ['brokenpkg==1']\n\n[tool.pytest.ini_options]\ntestpaths = ['tests']\n",
        encoding="utf-8",
    )
    weakened = RepairProposal(
        "hide tests",
        (
            FileReplacement(
                "pyproject.toml",
                "[project]\nname = 'demo'\ndependencies = []\n\n[tool.pytest.ini_options]\ntestpaths = ['empty']\n",
            ),
        ),
    )
    with pytest.raises(SecurityError, match="pytest discovery"):
        apply_repair_proposal(_snapshot(tmp_path), weakened)


@pytest.mark.parametrize("name", ["pytest.toml", ".pytest.toml", "pytest.ini", ".pytest.ini"])
def test_rejects_dedicated_pytest_configuration_changes_even_when_test_edits_are_allowed(
    tmp_path: Path,
    name: str,
) -> None:
    target = tmp_path / name
    target.write_text("[pytest]\naddopts = '-q'\n", encoding="utf-8")
    proposal = RepairProposal(
        "hide failures",
        (FileReplacement(name, "[pytest]\naddopts = '-q --ignore=tests'\n"),),
    )

    with pytest.raises(SecurityError, match="pytest discovery"):
        apply_repair_proposal(_snapshot(tmp_path), proposal, allow_test_changes=True)


def test_allows_pyproject_dependency_change_when_test_configuration_is_unchanged(tmp_path: Path) -> None:
    target = tmp_path / "pyproject.toml"
    target.write_text(
        "[project]\nname = 'demo'\ndependencies = ['brokenpkg==1']\n\n[tool.pytest.ini_options]\ntestpaths = ['tests']\n",
        encoding="utf-8",
    )
    proposal = RepairProposal(
        "fix dependency",
        (
            FileReplacement(
                "pyproject.toml",
                "[project]\nname = 'demo'\ndependencies = ['fixedpkg==1']\n\n[tool.pytest.ini_options]\ntestpaths = ['tests']\n",
            ),
        ),
    )

    apply_repair_proposal(_snapshot(tmp_path), proposal)

    assert "fixedpkg==1" in target.read_text(encoding="utf-8")


def test_allows_existing_dependency_manifest_replacement(tmp_path: Path) -> None:
    target = tmp_path / "requirements.txt"
    target.write_text("brokenpkg==1\n", encoding="utf-8")
    proposal = RepairProposal("fix deps", (FileReplacement("requirements.txt", "fixedpkg==1\n"),))

    applied = apply_repair_proposal(_snapshot(tmp_path), proposal)

    assert target.read_text(encoding="utf-8") == "fixedpkg==1\n"
    assert applied[0]["path"] == "requirements.txt"


def test_collects_dependency_manifest_context(tmp_path: Path) -> None:
    (tmp_path / "pyproject.toml").write_text("[project]\nname = 'demo'\n", encoding="utf-8")
    (tmp_path / "requirements.txt").write_text("pytest>=8\n", encoding="utf-8")
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "app.py").write_text("def answer():\n    return 1\n", encoding="utf-8")
    total, files = inventory(tmp_path)
    snapshot = RepositorySnapshot(tmp_path, "demo/app", "https://github.com/demo/app", "abc", total, files)

    context = collect_repair_context(snapshot, {"execution": {"stderr": "install failed"}})

    assert [item["path"] for item in context[:2]] == ["pyproject.toml", "requirements.txt"]


def test_openai_agent_receives_dependency_install_failure_logs(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    (tmp_path / "requirements.txt").write_text("missingpkg==1\n", encoding="utf-8")
    (tmp_path / "app.py").write_text("print('ok')\n", encoding="utf-8")
    total, files = inventory(tmp_path)
    snapshot = RepositorySnapshot(tmp_path, "demo/app", "https://github.com/demo/app", "abc", total, files)
    recorded: dict[str, object] = {}

    class FakeResponses:
        def create(self, **kwargs: object) -> object:
            recorded.update(kwargs)
            return SimpleNamespace(
                output_text='{"analysis":"fix dependency","changes":[{"path":"requirements.txt","content":"pytest>=8\\n"}]}'
            )

    fake_module = SimpleNamespace(OpenAI=lambda: SimpleNamespace(responses=FakeResponses()))
    monkeypatch.setitem(sys.modules, "openai", fake_module)

    OpenAIRepairAgent(model="test-model").propose(
        snapshot,
        issue="installation fails",
        verification={
            "status": "dependency_install_failed",
            "command": "python -m pytest -q",
            "install": {
                "exit_code": 1,
                "timed_out": False,
                "stdout": "",
                "stderr": "No matching distribution found for missingpkg==1",
            },
            "execution": None,
        },
        attempt=1,
    )

    prompt = str(recorded["input"])
    assert "dependency_install_failed" in prompt
    assert "No matching distribution found for missingpkg==1" in prompt
    assert "requirements.txt" in prompt


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
