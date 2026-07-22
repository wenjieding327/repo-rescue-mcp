from __future__ import annotations

import configparser
import json
import re
import tomllib
from pathlib import Path
from typing import Any

from packaging.requirements import InvalidRequirement, Requirement

from .repository import RepositorySnapshot
from .security import safe_child


MANIFESTS = (
    "pyproject.toml",
    "requirements.txt",
    "requirements-dev.txt",
    "setup.cfg",
    "setup.py",
    "Pipfile",
    "environment.yml",
    "runtime.txt",
    ".python-version",
)


def _read_text(root: Path, relative: str, limit: int = 131_072) -> str | None:
    path = safe_child(root, relative)
    if not path.is_file() or path.is_symlink() or path.stat().st_size > limit:
        return None
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None


def _requirement_lines(text: str) -> tuple[list[str], list[str]]:
    dependencies: list[str] = []
    rejected: list[str] = []
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith(("-", ".", "/")) or " @ " in line or "://" in line:
            rejected.append(line)
            continue
        try:
            parsed = Requirement(line)
        except InvalidRequirement:
            rejected.append(line)
            continue
        dependencies.append(str(parsed))
    return dependencies, rejected


def _pyproject(text: str) -> dict[str, Any]:
    try:
        data = tomllib.loads(text)
    except tomllib.TOMLDecodeError:
        return {"parse_error": "Invalid pyproject.toml"}
    project = data.get("project", {}) if isinstance(data.get("project", {}), dict) else {}
    dependencies = project.get("dependencies", []) if isinstance(project.get("dependencies", []), list) else []
    optional = project.get("optional-dependencies", {})
    dependency_groups = data.get("dependency-groups", {})
    build = data.get("build-system", {}) if isinstance(data.get("build-system", {}), dict) else {}
    test_dependencies: list[str] = []
    if isinstance(dependency_groups, dict):
        selected_group = next(
            (group_name for group_name in ("test", "tests") if isinstance(dependency_groups.get(group_name), list)),
            "dev" if isinstance(dependency_groups.get("dev"), list) else None,
        )
        if selected_group:
            group = dependency_groups[selected_group]
            test_dependencies.extend(str(item) for item in group if isinstance(item, str))
    return {
        "name": project.get("name"),
        "requires_python": project.get("requires-python"),
        "dependencies": [str(item) for item in dependencies],
        "optional_dependency_groups": sorted(optional) if isinstance(optional, dict) else [],
        "dependency_groups": sorted(dependency_groups) if isinstance(dependency_groups, dict) else [],
        "test_dependencies": test_dependencies,
        "build_backend": build.get("build-backend"),
    }


def _setup_cfg(text: str) -> dict[str, Any]:
    parser = configparser.ConfigParser()
    try:
        parser.read_string(text)
    except configparser.Error:
        return {"parse_error": "Invalid setup.cfg"}
    requires_python = parser.get("options", "python_requires", fallback=None)
    raw_dependencies = parser.get("options", "install_requires", fallback="")
    dependencies, rejected = _requirement_lines(raw_dependencies)
    return {"requires_python": requires_python, "dependencies": dependencies, "rejected_dependencies": rejected}


def analyze_snapshot(snapshot: RepositorySnapshot) -> dict[str, Any]:
    root = snapshot.path
    file_set = set(snapshot.files)
    manifests: dict[str, Any] = {}
    declared_dependencies: list[str] = []
    execution_dependencies: list[str] = []
    rejected_dependencies: list[dict[str, str]] = []
    python_hints: list[dict[str, str]] = []
    evidence: list[dict[str, str]] = []

    for manifest in MANIFESTS:
        if manifest not in file_set:
            continue
        text = _read_text(root, manifest)
        if text is None:
            manifests[manifest] = {"status": "unreadable_or_too_large"}
            continue
        evidence.append({"source": manifest, "fact": "manifest_present"})
        if manifest.startswith("requirements"):
            accepted, rejected = _requirement_lines(text)
            declared_dependencies.extend(accepted)
            rejected_dependencies.extend({"source": manifest, "value": item} for item in rejected)
            manifests[manifest] = {"dependencies": accepted, "rejected": rejected}
        elif manifest == "pyproject.toml":
            parsed = _pyproject(text)
            manifests[manifest] = parsed
            declared_dependencies.extend(parsed.get("dependencies", []))
            execution_dependencies.extend(parsed.get("dependencies", []))
            execution_dependencies.extend(parsed.get("test_dependencies", []))
            if parsed.get("requires_python"):
                python_hints.append({"source": manifest, "value": str(parsed["requires_python"])})
        elif manifest == "setup.cfg":
            parsed = _setup_cfg(text)
            manifests[manifest] = parsed
            declared_dependencies.extend(parsed.get("dependencies", []))
            execution_dependencies.extend(parsed.get("dependencies", []))
            if parsed.get("requires_python"):
                python_hints.append({"source": manifest, "value": str(parsed["requires_python"])})
        elif manifest in {"runtime.txt", ".python-version"}:
            value = text.strip()[:100]
            manifests[manifest] = {"value": value}
            python_hints.append({"source": manifest, "value": value})
        else:
            manifests[manifest] = {"status": "present", "preview": text[:300]}

    test_files = [name for name in snapshot.files if name.startswith("tests/") and name.endswith(".py")]
    python_paths = ["."]
    if any(name.startswith("src/") and name.endswith(".py") for name in snapshot.files):
        python_paths.append("src")
    likely_entries = [
        name
        for name in ("main.py", "app.py", "manage.py", "run.py", "cli.py")
        if name in file_set
    ]
    suggested_commands: list[str] = []
    if test_files or "pytest.ini" in file_set or "conftest.py" in file_set:
        suggested_commands.append("python -m pytest -q")
    if "main.py" in likely_entries:
        suggested_commands.append("python main.py --help")
    if not suggested_commands:
        suggested_commands.append("python -m compileall -q .")

    risks: list[dict[str, str]] = []
    if "setup.py" in file_set:
        risks.append({"level": "medium", "source": "setup.py", "reason": "Packaging may execute project code during installation."})
    if rejected_dependencies:
        risks.append({"level": "high", "source": "dependency manifests", "reason": "URL, option, path or invalid requirements were rejected."})
    if any(name.endswith((".so", ".dll", ".dylib")) for name in snapshot.files):
        risks.append({"level": "medium", "source": "repository tree", "reason": "Repository contains native binaries."})
    if "Dockerfile" in file_set:
        risks.append({"level": "info", "source": "Dockerfile", "reason": "Project supplies its own container recipe; it is not executed automatically."})

    readme_name = next((name for name in ("README.md", "README.rst", "README.txt", "README") if name in file_set), None)
    readme_preview = _read_text(root, readme_name, limit=32_768)[:2_000] if readme_name and _read_text(root, readme_name, limit=32_768) else None

    unique_dependencies = list(dict.fromkeys(declared_dependencies))
    unique_execution_dependencies = list(dict.fromkeys(execution_dependencies or declared_dependencies))
    return {
        "repository": {
            "slug": snapshot.slug,
            "url": snapshot.source_url,
            "commit": snapshot.commit,
            "total_bytes": snapshot.total_bytes,
            "file_count": len(snapshot.files),
        },
        "detected_language": "python" if any(name.endswith(".py") for name in snapshot.files) else "unknown",
        "manifests": manifests,
        "declared_dependencies": unique_dependencies,
        "execution_dependencies": unique_execution_dependencies,
        "rejected_dependencies": rejected_dependencies,
        "python_version_hints": python_hints,
        "likely_entrypoints": likely_entries,
        "test_file_count": len(test_files),
        "python_paths": python_paths,
        "suggested_verification_commands": suggested_commands,
        "risks": risks,
        "evidence": evidence,
        "readme_preview": readme_preview,
        "bounded_file_tree": list(snapshot.files[:300]),
    }


def json_report(report: dict[str, Any]) -> str:
    return json.dumps(report, ensure_ascii=False, indent=2)
