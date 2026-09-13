"""Run the actual trusted pytest worker against small, trusted fixture repos."""

from pathlib import Path

import pytest

from repo_rescue.analysis import analyze_snapshot
from repo_rescue.repository import RepositorySnapshot, inventory
from repo_rescue.runner import reproduce
from repo_rescue.verifier import DockerRepositoryVerifier


def _run_fixture(root: Path, monkeypatch: pytest.MonkeyPatch) -> dict:
    total, files = inventory(root)
    snapshot = RepositorySnapshot(
        root, "fixture/discovery", "https://github.com/fixture/discovery", "abc", total, files,
    )
    monkeypatch.setenv("REPO_RESCUE_ALLOWED_REPOS", snapshot.slug)
    # Only code authored in these fixtures runs on the host. External repos
    # use the default Docker backend; this does not change product defaults.
    monkeypatch.setenv("REPO_RESCUE_EXECUTION_BACKEND", "direct")
    return reproduce(snapshot, analyze_snapshot(snapshot))


def _write(root: Path, relative: str, text: str) -> None:
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


@pytest.mark.parametrize("name", ["test.py", "tests.py", "src/tests.py", "src/math_tests.py"])
def test_conventional_modules_run_without_operator_selected_paths(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, name: str,
) -> None:
    _write(tmp_path, name, "import unittest\nclass Checks(unittest.TestCase):\n    def test_ok(self):\n        self.assertEqual(1 + 1, 2)\n")
    _write(tmp_path, "tox.ini", "[tox]\nenvlist = py\n[testenv]\ncommands = zope-testrunner --test-path=src\n")
    result = _run_fixture(tmp_path, monkeypatch)
    assert result["verification_command"] == "python -m pytest -q"
    assert result["pytest_discovery_policy"] == "project-config-or-extended-defaults-v1"
    assert result["verified"] is True
    assert result["execution"]["pytest_attestation"]["passed"] == 1


def test_default_discovery_keeps_existing_tests_and_newly_discovered_failures(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    _write(tmp_path, "test_existing.py", "def test_ok(): assert True\n")
    _write(tmp_path, "src/tests.py", "def test_failure(): assert False\n")
    result = _run_fixture(tmp_path, monkeypatch)
    assert result["verified"] is False
    assert result["execution"]["pytest_attestation"]["collected"] == 2
    assert result["execution"]["pytest_attestation"]["passed"] == 1
    assert result["execution"]["pytest_attestation"]["failed"] == 1


@pytest.mark.parametrize(
    ("name", "content"),
    [
        ("pytest.ini", "[pytest]\npython_files = check_*.py\n"),
        ("tox.ini", "[pytest]\npython_files = check_*.py\n"),
        ("setup.cfg", "[tool:pytest]\npython_files = check_*.py\n"),
        ("pyproject.toml", '[tool.pytest.ini_options]\npython_files = ["check_*.py"]\n'),
        ("pyproject.toml", '[tool.pytest]\npython_files = ["check_*.py"]\n'),
        ("pytest.toml", '[pytest]\npython_files = ["check_*.py"]\n'),
        ("pytest.ini", "[pytest]\naddopts = -o python_files=check_*.py\n"),
    ],
)
def test_explicit_file_patterns_remain_authoritative(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, name: str, content: str,
) -> None:
    _write(tmp_path, name, content)
    _write(tmp_path, "check_selected.py", "def test_selected(): assert True\n")
    _write(tmp_path, "tests.py", "raise AssertionError('must not collect excluded module')\n")
    result = _run_fixture(tmp_path, monkeypatch)
    assert result["verified"] is True
    assert result["execution"]["pytest_attestation"]["collected"] == 1


@pytest.mark.parametrize(
    "configuration",
    [
        "python_files = test_*.py *_test.py",
        "addopts = -o 'python_files=test_*.py *_test.py'",
    ],
)
def test_explicit_default_patterns_are_not_silently_extended(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, configuration: str,
) -> None:
    _write(tmp_path, "pytest.ini", f"[pytest]\n{configuration}\n")
    _write(tmp_path, "test_selected.py", "def test_selected(): assert True\n")
    _write(tmp_path, "tests.py", "raise AssertionError('explicit defaults must be preserved')\n")
    result = _run_fixture(tmp_path, monkeypatch)
    assert result["verified"] is True
    assert result["execution"]["pytest_attestation"]["collected"] == 1


def test_testpaths_is_not_replaced_by_detected_file_paths(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    _write(tmp_path, "pytest.ini", "[pytest]\ntestpaths = unit\nfilterwarnings = error\n")
    _write(tmp_path, "unit/tests.py", "def test_selected(): assert True\n")
    _write(tmp_path, "integration/tests.py", "raise AssertionError('outside testpaths')\n")
    result = _run_fixture(tmp_path, monkeypatch)
    assert result["verified"] is True
    assert result["execution"]["pytest_attestation"]["passed"] == 1
    assert "deprecated" not in result["execution"]["stderr"]


def test_empty_configured_file_patterns_still_fail_closed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    _write(tmp_path, "pytest.ini", "[pytest]\npython_files =\n")
    _write(tmp_path, "tests.py", "def test_not_selected(): assert True\n")
    result = _run_fixture(tmp_path, monkeypatch)
    assert result["verified"] is False
    assert result["execution"]["exit_code"] == 5
    assert result["execution"]["pytest_attestation"]["collected"] == 0


def test_empty_extended_module_is_not_evidence_of_success(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    _write(tmp_path, "src/tests.py", "# no tests here\n")
    result = _run_fixture(tmp_path, monkeypatch)
    assert result["verified"] is False
    assert result["execution"]["pytest_attestation"]["collected"] == 0


def test_bridge_verifier_preserves_the_actual_discovery_policy(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    _write(tmp_path, "src/tests.py", "def test_selected(): assert True\n")
    raw = _run_fixture(tmp_path, monkeypatch)
    total, files = inventory(tmp_path)
    snapshot = RepositorySnapshot(tmp_path, "fixture/discovery", "builtin://discovery", "abc", total, files)
    monkeypatch.setattr("repo_rescue.verifier.reproduce", lambda *_args: raw)
    result = DockerRepositoryVerifier().verify(snapshot, analyze_snapshot(snapshot))
    assert result["verified"] is True
    assert result["command"] == raw["verification_command"]
    assert result["pytest_discovery_policy"] == raw["pytest_discovery_policy"]
    assert result["execution"] == raw["execution"]
