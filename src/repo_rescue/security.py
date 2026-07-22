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
    target = (root / relative).resolve()
    root_resolved = root.resolve()
    if root_resolved != target and root_resolved not in target.parents:
        raise SecurityError("Path traversal is not allowed.")
    return target


def redact(text: str, limit: int = 65_536) -> str:
    bounded = text[:limit]
    for pattern in _SECRET_PATTERNS:
        bounded = pattern.sub(lambda match: f"{match.group(1)}=[REDACTED]" if match.lastindex else "[REDACTED]", bounded)
    if len(text) > limit:
        bounded += f"\n[output truncated after {limit} characters]"
    return bounded

