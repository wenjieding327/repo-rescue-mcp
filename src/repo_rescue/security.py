from __future__ import annotations

import os
import re
from pathlib import Path
from urllib.parse import urlparse


class SecurityError(ValueError):
    """Raised when an input violates a RepoRescue security boundary."""


_OWNER_REPO = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
_SECRET_PATTERNS = (
    re.compile(r"(?i)(api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+"),
    re.compile(r"gh[pousr]_[A-Za-z0-9_]{20,}"),
    re.compile(r"AKIA[0-9A-Z]{16}"),
)


def normalize_github_url(value: str) -> tuple[str, str]:
    """Return a canonical HTTPS clone URL and normalized owner/repository."""
    candidate = value.strip()
    parsed = urlparse(candidate)
    if parsed.scheme != "https" or parsed.hostname not in {"github.com", "www.github.com"}:
        raise SecurityError("Only public https://github.com repositories are supported.")
    if parsed.username or parsed.password or parsed.port:
        raise SecurityError("Credentials and custom ports are not allowed in repository URLs.")
    if parsed.params or parsed.query or parsed.fragment:
        raise SecurityError("Repository URLs may not contain parameters, queries, or fragments.")
    parts = [part for part in parsed.path.split("/") if part]
    if len(parts) != 2:
        raise SecurityError("Repository URL must be exactly https://github.com/owner/repository.")
    owner, repository = parts
    if repository.endswith(".git"):
        repository = repository[:-4]
    slug = f"{owner}/{repository}"
    if not _OWNER_REPO.fullmatch(slug):
        raise SecurityError("Repository owner or name contains unsupported characters.")
    return f"https://github.com/{slug}.git", slug.lower()


def execution_allowlist() -> set[str]:
    raw = os.getenv("REPO_RESCUE_ALLOWED_REPOS", "")
    return {item.strip().lower().removesuffix(".git") for item in raw.split(",") if item.strip()}


def require_execution_allowed(slug: str) -> None:
    if slug.lower() not in execution_allowlist():
        raise SecurityError(
            "Execution is disabled for this repository. Read-only inspection is still available. "
            "A repository must be explicitly added to REPO_RESCUE_ALLOWED_REPOS before it can run."
        )


def safe_child(root: Path, relative: str) -> Path:
    root_resolved = root.resolve()
    candidate = Path(relative)
    if candidate.is_absolute() or candidate.anchor or candidate.drive:
        raise SecurityError("Absolute paths are not allowed.")

    # Check the unresolved path one component at a time. Resolving first would
    # hide a repository symlink such as src/fix.py -> tests/helper.py and let a
    # non-test alias cross the test-edit boundary.
    target = root_resolved
    for part in candidate.parts:
        if part in {"", "."}:
            continue
        if part == "..":
            raise SecurityError("Path traversal is not allowed.")
        target = target / part
        if target.is_symlink():
            raise SecurityError("Symbolic links are not allowed in repair paths.")

    target = target.resolve()
    if root_resolved != target and root_resolved not in target.parents:
        raise SecurityError("Path traversal is not allowed.")
    return target


def redact(text: str | bytes, limit: int = 65_536) -> str:
    if isinstance(text, bytes):
        text = text.decode("utf-8", errors="replace")
    bounded = text[:limit]
    for pattern in _SECRET_PATTERNS:
        bounded = pattern.sub(lambda match: f"{match.group(1)}=[REDACTED]" if match.lastindex else "[REDACTED]", bounded)
    if len(text) > limit:
        bounded += f"\n[output truncated after {limit} characters]"
    return bounded


def redact_paths(text: str | bytes, replacements: list[tuple[Path, str]], limit: int = 65_536) -> str:
    bounded = redact(text, limit=limit)
    for path, label in replacements:
        raw = str(path)
        variants = {raw, raw.replace("\\", "/"), raw.replace("/", "\\")}
        for variant in sorted(variants, key=len, reverse=True):
            if variant:
                bounded = bounded.replace(variant, label)
    return bounded
