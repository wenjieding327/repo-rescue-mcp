from pathlib import Path
from types import SimpleNamespace

import pytest

from repo_rescue.repository import RepositorySnapshot, inventory
from repo_rescue.runner import _container_base, _copy_repository_tree, _reproduce_direct, _safe_dependencies
from repo_rescue.security import SecurityError, require_execution_allowed


def test_safe_dependencies_accepts_pep508() -> None:
    assert _safe_dependencies(["pytest>=8", "click==8.1.8"]) == ["pytest>=8", "click==8.1.8"]


def test_safe_dependencies_rejects_remote_url() -> None:
    with pytest.raises(SecurityError):
        _safe_dependencies(["demo @ https://example.com/demo.whl"])


def test_execution_requires_explicit_allowlist(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("REPO_RESCUE_ALLOWED_REPOS", "pallets/click")
    require_execution_allowed("pallets/click")
    with pytest.raises(SecurityError):
        require_execution_allowed("unknown/repository")


def test_direct_reproduction_reports_command_when_install_fails(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    (tmp_path / "app.py").write_text("print('ok')\n", encoding="utf-8")
    total, files = inventory(tmp_path)
    snapshot = RepositorySnapshot(tmp_path, "demo/app", "https://github.com/demo/app", "abc", total, files)

    monkeypatch.setattr(
        "repo_rescue.runner._run",
        lambda args, timeout: {
            "exit_code": 1,
            "timed_out": False,
            "duration_seconds": 0.1,
            "stdout": "",
            "stderr": "No matching distribution found",
        },
    )

    result = _reproduce_direct(
        snapshot,
        {"repository": {"slug": snapshot.slug}, "python_paths": ["."]},
        ["missingpkg==1"],
        "python -m pytest -q",
        30,
        30,
    )

    assert result["status"] == "dependency_install_failed"
    assert result["verification_command"] == "python -m pytest -q"


def test_click_install_failure_reports_the_same_profiled_command(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    (tmp_path / "app.py").write_text("print('ok')\n", encoding="utf-8")
    total, files = inventory(tmp_path)
    snapshot = RepositorySnapshot(tmp_path, "pallets/click", "https://github.com/pallets/click", "abc", total, files)
    monkeypatch.setattr(
        "repo_rescue.runner._run",
        lambda args, timeout: {
            "exit_code": 1,
            "timed_out": False,
            "duration_seconds": 0.1,
            "stdout": "",
            "stderr": "installation failed",
        },
    )

    result = _reproduce_direct(
        snapshot,
        {"repository": {"slug": snapshot.slug}, "python_paths": ["."]},
        ["missingpkg==1"],
        "python -m pytest -q",
        30,
        30,
    )

    assert result["verification_command"] == (
        "python -m pytest -q --ignore=tests/test_utils/test_echo_via_pager.py"
    )


def test_container_disables_user_site_and_pytest_plugin_autoload(tmp_path: Path) -> None:
    command = _container_base(network="none", work_dir=tmp_path)

    assert "PYTHONNOUSERSITE=1" in command
    assert "PYTEST_DISABLE_PLUGIN_AUTOLOAD=1" in command
    read_only_command = _container_base(network="none", work_dir=tmp_path, mount_read_only=True)
    assert any(item.endswith(",readonly") for item in read_only_command)


def test_linux_container_uses_host_uid_and_gid(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "repo_rescue.runner.os",
        SimpleNamespace(name="posix", getuid=lambda: 1234, getgid=lambda: 5678),
    )

    command = _container_base(network="none", work_dir=tmp_path)

    user_index = command.index("--user")
    assert command[user_index + 1] == "1234:5678"


def test_windows_container_keeps_native_bind_mount_identity(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("repo_rescue.runner.os", SimpleNamespace(name="nt"))

    command = _container_base(network="none", work_dir=tmp_path)

    assert "--user" not in command


def test_direct_verifier_cannot_be_shadowed_by_repository_pytest_module(tmp_path: Path) -> None:
    (tmp_path / "pytest.py").write_text("raise SystemExit(0)\n", encoding="utf-8")
    tests = tmp_path / "tests"
    tests.mkdir()
    (tests / "test_failure.py").write_text("def test_failure():\n    assert False\n", encoding="utf-8")
    total, files = inventory(tmp_path)
    snapshot = RepositorySnapshot(tmp_path, "demo/app", "https://github.com/demo/app", "abc", total, files)

    result = _reproduce_direct(
        snapshot,
        {"repository": {"slug": snapshot.slug}, "python_paths": ["."]},
        [],
        "python -m pytest -q",
        30,
        30,
    )

    assert result["status"] == "verification_failed"
    assert result["verified"] is False
    assert result["execution"]["exit_code"] != 0


def test_direct_pytest_requires_trusted_completion_and_a_passed_test(tmp_path: Path) -> None:
    tests = tmp_path / "tests"
    tests.mkdir()
    (tests / "test_pass.py").write_text("def test_pass():\n    assert True\n", encoding="utf-8")
    total, files = inventory(tmp_path)
    snapshot = RepositorySnapshot(tmp_path, "demo/app", "https://github.com/demo/app", "abc", total, files)

    result = _reproduce_direct(
        snapshot,
        {"repository": {"slug": snapshot.slug}, "python_paths": ["."]},
        [],
        "python -m pytest -q",
        30,
        30,
    )

    assert result["status"] == "verified"
    assert result["execution"]["pytest_attestation"]["completed"] is True
    assert result["execution"]["pytest_attestation"]["passed"] == 1


def test_direct_pytest_rejects_forced_zero_exit_without_completion(tmp_path: Path) -> None:
    (tmp_path / "app.py").write_text("import os\nos._exit(0)\n", encoding="utf-8")
    tests = tmp_path / "tests"
    tests.mkdir()
    (tests / "test_app.py").write_text("import app\n\ndef test_should_fail():\n    assert False\n", encoding="utf-8")
    total, files = inventory(tmp_path)
    snapshot = RepositorySnapshot(tmp_path, "demo/app", "https://github.com/demo/app", "abc", total, files)

    result = _reproduce_direct(
        snapshot,
        {"repository": {"slug": snapshot.slug}, "python_paths": ["."]},
        [],
        "python -m pytest -q",
        30,
        30,
    )

    assert result["execution"]["exit_code"] == 3
    assert result["execution"]["pytest_attestation"]["completed"] is False
    assert result["status"] == "verification_failed"
    assert result["verified"] is False


def test_direct_pytest_rejects_all_skipped_suite(tmp_path: Path) -> None:
    tests = tmp_path / "tests"
    tests.mkdir()
    (tests / "test_skip.py").write_text(
        "import pytest\n\n@pytest.mark.skip(reason='not evidence')\ndef test_skip():\n    assert True\n",
        encoding="utf-8",
    )
    total, files = inventory(tmp_path)
    snapshot = RepositorySnapshot(tmp_path, "demo/app", "https://github.com/demo/app", "abc", total, files)

    result = _reproduce_direct(
        snapshot,
        {"repository": {"slug": snapshot.slug}, "python_paths": ["."]},
        [],
        "python -m pytest -q",
        30,
        30,
    )

    assert result["execution"]["exit_code"] == 0
    assert result["execution"]["pytest_attestation"]["passed"] == 0
    assert result["status"] == "verification_failed"
    assert result["verified"] is False


def test_repository_code_cannot_mutate_trusted_pytest_evidence(tmp_path: Path) -> None:
    (tmp_path / "app.py").write_text(
        """
import gc

for candidate in gc.get_objects():
    if candidate.__class__.__name__ == "_RepoRescuePytestEvidence":
        candidate.collected = 1
        candidate.passed = 1
        candidate.failed = 0
        candidate.skipped = -1
        candidate.errors = 0
""".lstrip(),
        encoding="utf-8",
    )
    tests = tmp_path / "tests"
    tests.mkdir()
    (tests / "test_skip.py").write_text(
        "import app\nimport pytest\n\n@pytest.mark.skip(reason='not evidence')\ndef test_skip(): pass\n",
        encoding="utf-8",
    )
    total, files = inventory(tmp_path)
    snapshot = RepositorySnapshot(tmp_path, "demo/app", "https://github.com/demo/app", "abc", total, files)

    result = _reproduce_direct(
        snapshot,
        {"repository": {"slug": snapshot.slug}, "python_paths": ["."]},
        [],
        "python -m pytest -q",
        30,
        30,
    )

    assert result["execution"]["pytest_attestation"]["completed"] is True
    assert result["execution"]["pytest_attestation"]["passed"] == 0
    assert result["execution"]["pytest_attestation"]["skipped"] == 1
    assert result["status"] == "verification_failed"
    assert result["verified"] is False


def test_repository_atexit_cannot_forge_junit_or_worker_exit(tmp_path: Path) -> None:
    (tmp_path / "app.py").write_text(
        """
import atexit
import os
import tempfile
from pathlib import Path

def forge_result():
    forged = '<testsuites><testsuite tests="9" failures="0" errors="0" skipped="0" /></testsuites>'
    for target in Path(tempfile.gettempdir()).glob('repo-rescue-pytest-*.xml'):
        target.write_text(forged, encoding='utf-8')
    os._exit(0)

atexit.register(forge_result)
""".lstrip(),
        encoding="utf-8",
    )
    tests = tmp_path / "tests"
    tests.mkdir()
    (tests / "test_failure.py").write_text(
        "import app\n\ndef test_must_fail():\n    assert False\n",
        encoding="utf-8",
    )
    total, files = inventory(tmp_path)
    snapshot = RepositorySnapshot(tmp_path, "demo/app", "https://github.com/demo/app", "abc", total, files)

    result = _reproduce_direct(
        snapshot,
        {"repository": {"slug": snapshot.slug}, "python_paths": ["."]},
        [],
        "python -m pytest -q",
        30,
        30,
    )

    assert result["execution"]["exit_code"] != 0
    assert result["execution"]["pytest_attestation"]["failed"] == 1
    assert result["status"] == "verification_failed"
    assert result["verified"] is False


def test_repository_copy_does_not_follow_symlinks(tmp_path: Path) -> None:
    source = tmp_path / "source"
    destination = tmp_path / "destination"
    outside = tmp_path / "outside.txt"
    source.mkdir()
    outside.write_text("host-only\n", encoding="utf-8")
    (source / "app.py").write_text("print('ok')\n", encoding="utf-8")
    alias = source / "leak.txt"
    try:
        alias.symlink_to(outside)
    except OSError as exc:
        pytest.skip(f"symlink creation is unavailable: {exc}")

    _copy_repository_tree(source, destination)

    assert (destination / "app.py").is_file()
    assert not (destination / "leak.txt").exists()
