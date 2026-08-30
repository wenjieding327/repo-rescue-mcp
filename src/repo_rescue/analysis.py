from __future__ import annotations

import configparser
import json
import re
import shlex
import tomllib
from pathlib import Path, PurePosixPath
from typing import Any

from packaging.requirements import InvalidRequirement, Requirement

from .repository import RepositorySnapshot
from .security import safe_child


MANIFESTS = (
    "pyproject.toml",
    "pytest.toml",
    ".pytest.toml",
    "pytest.ini",
    ".pytest.ini",
    "requirements.txt",
    "requirements-dev.txt",
    "setup.cfg",
    "setup.py",
    "Pipfile",
    "environment.yml",
    "runtime.txt",
    ".python-version",
)

PYTEST_CONFIG_NAMES = {
    ".pytest.ini",
    ".pytest.toml",
    "conftest.py",
    "pytest.ini",
    "pytest.toml",
    "tox.ini",
}

_PYTEST_DECLARATION = re.compile(
    r"(?m)^\s*(?:(?:async\s+)?def\s+test_[A-Za-z0-9_]*\s*\(|class\s+Test[A-Za-z0-9_]*\b)"
)

_ROOT_PYTEST_CONFIGS = (
    "pytest.toml",
    ".pytest.toml",
    "pytest.ini",
    ".pytest.ini",
    "pyproject.toml",
    "tox.ini",
    "setup.cfg",
)


def _requirements_manifests(files: set[str]) -> list[str]:
    discovered = {
        name
        for name in files
        if Path(name).name.lower().startswith("requirements") and name.lower().endswith(".txt")
    }
    ordered: list[str] = []
    for name in (*MANIFESTS, *sorted(discovered)):
        if name in files and name not in ordered:
            ordered.append(name)
    return ordered


def _is_execution_requirements_manifest(relative: str) -> bool:
    path = Path(relative)
    if len(path.parts) == 1:
        return path.name.lower() in {
            "requirements.txt",
            "requirements-dev.txt",
            "requirements-test.txt",
            "requirements-tests.txt",
        }
    return any(part.lower() in {"test", "tests"} for part in path.parts[:-1])


def _is_test_tree_part(part: str) -> bool:
    lowered = part.lower()
    return bool(
        lowered in {"test", "tests", "testing", "spec", "specs"}
        or lowered.startswith(("test_", "tests_"))
        or lowered.endswith(("_test", "_tests"))
    )


def _is_test_file(relative: str) -> bool:
    path = Path(relative)
    if path.suffix.lower() != ".py":
        return False
    name = path.name.lower()
    named_test_tree = any(_is_test_tree_part(part) for part in path.parts[:-1])
    return bool(named_test_tree or name.startswith("test_") or name.endswith("_test.py"))


def _read_text(root: Path, relative: str, limit: int = 131_072) -> str | None:
    path = safe_child(root, relative)
    if not path.is_file() or path.is_symlink() or path.stat().st_size > limit:
        return None
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None


def _normalise_pytest_testpaths(raw: Any) -> list[str]:
    if isinstance(raw, str):
        try:
            candidates = shlex.split(raw, posix=True)
        except ValueError:
            return []
    elif isinstance(raw, list):
        candidates = [item for item in raw if isinstance(item, str)]
    else:
        return []

    normalised: list[str] = []
    for candidate in candidates:
        value = candidate.strip().replace("\\", "/")
        raw_parts = value.split("/")
        if (
            not value
            or value.startswith(("/", "-"))
            or re.match(r"^[A-Za-z]:", value)
            or any(part == ".." for part in raw_parts)
            or any(character in value for character in "*?[]")
        ):
            continue
        relative = PurePosixPath(value).as_posix()
        if relative not in {"", "."} and relative not in normalised:
            normalised.append(relative)
    return normalised


def _normalise_native_pytest_testpaths(raw: Any) -> list[str]:
    if not isinstance(raw, list) or not all(isinstance(item, str) for item in raw):
        return []
    return _normalise_pytest_testpaths(raw)


def _pytest_testpaths_from_toml(text: str, name: str) -> tuple[bool, list[str]]:
    try:
        data = tomllib.loads(text.lstrip("\ufeff"))
    except tomllib.TOMLDecodeError:
        return True, []
    if name in {"pytest.toml", ".pytest.toml"}:
        options = data.get("pytest", {})
        if not isinstance(options, dict):
            return True, []
        return True, _normalise_native_pytest_testpaths(options.get("testpaths"))

    tool = data.get("tool", {})
    if not isinstance(tool, dict) or "pytest" not in tool:
        return False, []
    pytest = tool.get("pytest")
    if not isinstance(pytest, dict):
        return True, []
    native_options = {key: value for key, value in pytest.items() if key != "ini_options"}
    missing = object()
    ini_options = pytest.get("ini_options", missing)
    if native_options and ini_options is not missing:
        return True, []
    if native_options:
        return True, _normalise_native_pytest_testpaths(native_options.get("testpaths"))
    if ini_options is not missing:
        if not isinstance(ini_options, dict):
            return True, []
        return True, _normalise_pytest_testpaths(ini_options.get("testpaths"))
    return False, []


def _pytest_testpaths_from_ini(text: str, name: str) -> tuple[bool, list[str]]:
    parser = configparser.ConfigParser(interpolation=None)
    try:
        parser.read_string(text.lstrip("\ufeff"))
    except configparser.Error:
        return True, []
    if name == "setup.cfg":
        if parser.has_section("tool:pytest"):
            value = parser.get("tool:pytest", "testpaths", fallback=None)
            return True, _normalise_pytest_testpaths(value)
        if parser.has_section("pytest"):
            return True, []
        return False, []
    if name in {"pytest.ini", ".pytest.ini"}:
        value = parser.get("pytest", "testpaths", fallback=None)
        return True, _normalise_pytest_testpaths(value)
    if parser.has_section("pytest"):
        value = parser.get("pytest", "testpaths", fallback=None)
        return True, _normalise_pytest_testpaths(value)
    return False, []


def _root_pytest_testpaths(root: Path, files: set[str]) -> list[str]:
    for name in _ROOT_PYTEST_CONFIGS:
        if name not in files:
            continue
        text = _read_text(root, name)
        if text is None:
            return []
        if name.endswith(".toml"):
            valid, configured = _pytest_testpaths_from_toml(text, name)
        else:
            valid, configured = _pytest_testpaths_from_ini(text, name)
        if valid:
            return configured
    return []


def _linked_nested_requirements(
    files: set[str],
    test_files: list[str],
    configured_testpaths: list[str],
) -> set[str]:
    requirements_by_directory = {
        PurePosixPath(name).parent.as_posix(): name
        for name in files
        if PurePosixPath(name).name == "requirements.txt"
        and len(PurePosixPath(name).parts) > 1
    }
    linked: set[str] = set()
    for configured in configured_testpaths:
        prefix = f"{configured.rstrip('/')}/"
        if not any(name == configured or name.startswith(prefix) for name in test_files):
            continue
        parts = PurePosixPath(configured).parts
        test_tree_index = next(
            (index for index, part in enumerate(parts) if _is_test_tree_part(part)),
            None,
        )
        if test_tree_index is None or test_tree_index == 0:
            continue
        application_root = PurePosixPath(*parts[:test_tree_index])
        candidate = application_root
        while candidate.as_posix() != ".":
            manifest = requirements_by_directory.get(candidate.as_posix())
            if manifest:
                linked.add(manifest)
                break
            candidate = candidate.parent
    return linked


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
    tool = data.get("tool", {}) if isinstance(data.get("tool", {}), dict) else {}
    pytest_table = tool.get("pytest")
    pytest_configured = bool(
        isinstance(pytest_table, dict)
        and (
            "ini_options" in pytest_table
            or any(key != "ini_options" for key in pytest_table)
        )
    )
    test_dependencies: list[str] = []
    if isinstance(optional, dict):
        selected_extra = next(
            (group_name for group_name in ("test", "tests") if isinstance(optional.get(group_name), list)),
            None,
        )
        if selected_extra:
            group = optional[selected_extra]
            test_dependencies.extend(str(item) for item in group if isinstance(item, str))
    if isinstance(dependency_groups, dict):
        selected_group = next(
            (group_name for group_name in ("test", "tests") if isinstance(dependency_groups.get(group_name), list)),
            None,
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
        "pytest_configured": pytest_configured,
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
    return {
        "requires_python": requires_python,
        "dependencies": dependencies,
        "rejected_dependencies": rejected,
        "pytest_configured": parser.has_section("tool:pytest"),
    }


def analyze_snapshot(snapshot: RepositorySnapshot) -> dict[str, Any]:
    root = snapshot.path
    file_set = set(snapshot.files)
    test_files = [name for name in snapshot.files if _is_test_file(name)]
    configured_testpaths = _root_pytest_testpaths(root, file_set)
    linked_requirements = _linked_nested_requirements(file_set, test_files, configured_testpaths)
    manifests: dict[str, Any] = {}
    declared_dependencies: list[str] = []
    execution_dependencies: list[str] = []
    rejected_dependencies: list[dict[str, str]] = []
    python_hints: list[dict[str, str]] = []
    evidence: list[dict[str, str]] = []

    for manifest in _requirements_manifests(file_set):
        if manifest not in file_set:
            continue
        text = _read_text(root, manifest)
        if text is None:
            manifests[manifest] = {"status": "unreadable_or_too_large"}
            continue
        evidence.append({"source": manifest, "fact": "manifest_present"})
        if Path(manifest).name.lower().startswith("requirements"):
            accepted, rejected = _requirement_lines(text)
            selected_for_execution = (
                _is_execution_requirements_manifest(manifest)
                or manifest in linked_requirements
            )
            if selected_for_execution:
                declared_dependencies.extend(accepted)
                execution_dependencies.extend(accepted)
            rejected_dependencies.extend({"source": manifest, "value": item} for item in rejected)
            manifests[manifest] = {
                "dependencies": accepted,
                "rejected": rejected,
                "selected_for_execution": selected_for_execution,
            }
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

    static_test_module_count = sum(
        1
        for name in test_files
        if _PYTEST_DECLARATION.search(_read_text(root, name) or "")
    )
    python_paths = ["."]
    if any(name.startswith("src/") and name.endswith(".py") for name in snapshot.files):
        python_paths.append("src")
    likely_entries = [
        name
        for name in ("main.py", "app.py", "manage.py", "run.py", "cli.py")
        if name in file_set
    ]
    suggested_commands: list[str] = []
    pytest_configuration_files = sorted(
        name for name in file_set if Path(name).name.lower() in PYTEST_CONFIG_NAMES
    )
    pytest_configured = bool(
        pytest_configuration_files
        or manifests.get("pyproject.toml", {}).get("pytest_configured")
        or manifests.get("setup.cfg", {}).get("pytest_configured")
    )
    if test_files or pytest_configured:
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
        "static_test_module_count": static_test_module_count,
        "pytest_configuration_files": pytest_configuration_files,
        "python_paths": python_paths,
        "suggested_verification_commands": suggested_commands,
        "risks": risks,
        "evidence": evidence,
        "readme_preview": readme_preview,
        "bounded_file_tree": list(snapshot.files[:300]),
    }


def json_report(report: dict[str, Any]) -> str:
    return json.dumps(report, ensure_ascii=False, indent=2)
