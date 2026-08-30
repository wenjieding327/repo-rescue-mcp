from pathlib import Path

import pytest

from repo_rescue.analysis import analyze_snapshot
from repo_rescue.repository import RepositorySnapshot, inventory


def test_analyzes_python_project_with_evidence(tmp_path: Path) -> None:
    (tmp_path / "pyproject.toml").write_text(
        """
[project]
name = "student-demo"
requires-python = ">=3.10"
dependencies = ["click>=8", "requests==2.32.3"]

[dependency-groups]
test = ["pytest>=8"]
""".strip(),
        encoding="utf-8",
    )
    (tmp_path / "main.py").write_text("print('hello')\n", encoding="utf-8")
    tests = tmp_path / "tests"
    tests.mkdir()
    (tests / "test_demo.py").write_text("def test_ok(): assert True\n", encoding="utf-8")
    total, files = inventory(tmp_path)
    snapshot = RepositorySnapshot(
        path=tmp_path,
        slug="student/demo",
        source_url="https://github.com/student/demo",
        commit="abc123",
        total_bytes=total,
        files=files,
    )

    result = analyze_snapshot(snapshot)

    assert result["detected_language"] == "python"
    assert result["python_version_hints"] == [{"source": "pyproject.toml", "value": ">=3.10"}]
    assert result["declared_dependencies"] == ["click>=8", "requests==2.32.3"]
    assert result["execution_dependencies"] == ["click>=8", "requests==2.32.3", "pytest>=8"]
    assert result["suggested_verification_commands"][0] == "python -m pytest -q"
    assert result["static_test_module_count"] == 1
    assert result["python_paths"] == ["."]
    assert result["repository"]["commit"] == "abc123"


def test_rejects_remote_and_option_requirements(tmp_path: Path) -> None:
    (tmp_path / "requirements.txt").write_text(
        "requests==2.32.3\n-e git+https://github.com/example/pkg\n--extra-index-url https://example.com\n",
        encoding="utf-8",
    )
    (tmp_path / "app.py").write_text("print('ok')\n", encoding="utf-8")
    total, files = inventory(tmp_path)
    snapshot = RepositorySnapshot(tmp_path, "student/demo", "https://github.com/student/demo", "abc", total, files)

    result = analyze_snapshot(snapshot)

    assert result["declared_dependencies"] == ["requests==2.32.3"]
    assert len(result["rejected_dependencies"]) == 2
    assert any(risk["level"] == "high" for risk in result["risks"])


def test_merges_pyproject_optional_test_and_requirements_dependencies(tmp_path: Path) -> None:
    (tmp_path / "pyproject.toml").write_text(
        """
[project]
name = "student-demo"
dependencies = ["click>=8"]

[project.optional-dependencies]
test = ["pytest>=8", "coverage[toml]>=7"]
""".strip(),
        encoding="utf-8",
    )
    (tmp_path / "requirements.txt").write_text("requests==2.32.3\n", encoding="utf-8")
    (tmp_path / "main.py").write_text("print('ok')\n", encoding="utf-8")
    total, files = inventory(tmp_path)
    snapshot = RepositorySnapshot(tmp_path, "student/demo", "https://github.com/student/demo", "abc", total, files)

    result = analyze_snapshot(snapshot)

    assert result["declared_dependencies"] == ["click>=8", "requests==2.32.3"]
    assert result["execution_dependencies"] == ["click>=8", "pytest>=8", "coverage[toml]>=7", "requests==2.32.3"]


def test_parses_nested_requirements_manifest(tmp_path: Path) -> None:
    docs = tmp_path / "docs"
    docs.mkdir()
    (docs / "requirements.txt").write_text("sphinx==8.2.3\n", encoding="utf-8")
    (tmp_path / "app.py").write_text("print('ok')\n", encoding="utf-8")
    total, files = inventory(tmp_path)
    snapshot = RepositorySnapshot(tmp_path, "student/demo", "https://github.com/student/demo", "abc", total, files)

    result = analyze_snapshot(snapshot)

    assert result["manifests"]["docs/requirements.txt"]["dependencies"] == ["sphinx==8.2.3"]
    assert result["manifests"]["docs/requirements.txt"]["selected_for_execution"] is False
    assert result["execution_dependencies"] == []


def test_detects_root_and_singular_test_layouts(tmp_path: Path) -> None:
    (tmp_path / "test_root.py").write_text("def test_root(): assert True\n", encoding="utf-8")
    singular = tmp_path / "test"
    singular.mkdir()
    (singular / "checks.py").write_text("def test_nested(): assert True\n", encoding="utf-8")
    total, files = inventory(tmp_path)
    snapshot = RepositorySnapshot(tmp_path, "student/demo", "https://github.com/student/demo", "abc", total, files)

    result = analyze_snapshot(snapshot)

    assert result["test_file_count"] == 2
    assert result["static_test_module_count"] == 2
    assert result["suggested_verification_commands"][0] == "python -m pytest -q"


def test_pyproject_pytest_configuration_selects_pytest(tmp_path: Path) -> None:
    (tmp_path / "pyproject.toml").write_text("[tool.pytest.ini_options]\naddopts = '-q'\n", encoding="utf-8")
    (tmp_path / "app.py").write_text("print('ok')\n", encoding="utf-8")
    total, files = inventory(tmp_path)
    snapshot = RepositorySnapshot(tmp_path, "student/demo", "https://github.com/student/demo", "abc", total, files)

    result = analyze_snapshot(snapshot)

    assert result["suggested_verification_commands"][0] == "python -m pytest -q"


@pytest.mark.parametrize(
    ("name", "content"),
    [
        ("pytest.toml", "[pytest]\naddopts = '-q'\n"),
        (".pytest.toml", "[pytest]\naddopts = '-q'\n"),
        ("pytest.ini", "[pytest]\naddopts = -q\n"),
        (".pytest.ini", "[pytest]\naddopts = -q\n"),
    ],
)
def test_dedicated_pytest_configuration_selects_pytest(
    tmp_path: Path,
    name: str,
    content: str,
) -> None:
    (tmp_path / name).write_text(content, encoding="utf-8")
    (tmp_path / "app.py").write_text("print('ok')\n", encoding="utf-8")
    total, files = inventory(tmp_path)
    snapshot = RepositorySnapshot(tmp_path, "student/demo", "https://github.com/student/demo", "abc", total, files)

    result = analyze_snapshot(snapshot)

    assert name in result["pytest_configuration_files"]
    assert result["suggested_verification_commands"][0] == "python -m pytest -q"


def test_does_not_auto_install_docs_or_generic_dev_dependencies(tmp_path: Path) -> None:
    (tmp_path / "requirements-docs.txt").write_text("sphinx==8.2.3\n", encoding="utf-8")
    (tmp_path / "pyproject.toml").write_text(
        "[project]\nname = 'demo'\n\n[project.optional-dependencies]\ndev = ['ruff==0.12.0']\n",
        encoding="utf-8",
    )
    (tmp_path / "app.py").write_text("print('ok')\n", encoding="utf-8")
    total, files = inventory(tmp_path)
    snapshot = RepositorySnapshot(tmp_path, "student/demo", "https://github.com/student/demo", "abc", total, files)

    result = analyze_snapshot(snapshot)

    assert result["manifests"]["requirements-docs.txt"]["selected_for_execution"] is False
    assert result["execution_dependencies"] == []
