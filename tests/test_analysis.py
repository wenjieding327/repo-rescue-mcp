from pathlib import Path

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
