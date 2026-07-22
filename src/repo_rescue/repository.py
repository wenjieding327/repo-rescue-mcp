from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator

from dulwich import porcelain
from dulwich.repo import Repo

from .security import SecurityError, normalize_github_url


EXCLUDED_DIRS = {
    ".git",
    ".venv",
    "venv",
    "node_modules",
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    "dist",
    "build",
}


@dataclass(frozen=True)
class RepositorySnapshot:
    path: Path
    slug: str
    source_url: str
    commit: str
    total_bytes: int
    files: tuple[str, ...]


def _run_git(args: list[str], *, cwd: Path | None = None, timeout: int = 60) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", *args],
        cwd=cwd,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        timeout=timeout,
        check=False,
        env={**os.environ, "GIT_TERMINAL_PROMPT": "0", "GIT_CONFIG_NOSYSTEM": "1"},
    )


def inventory(root: Path, *, max_files: int = 5_000, max_bytes: int | None = None) -> tuple[int, tuple[str, ...]]:
    if max_bytes is None:
        max_bytes = int(os.getenv("REPO_RESCUE_MAX_REPO_MB", "50")) * 1024 * 1024
    total = 0
    files: list[str] = []
    for current, dirs, names in os.walk(root):
        dirs[:] = sorted(directory for directory in dirs if directory not in EXCLUDED_DIRS)
        for name in sorted(names):
            path = Path(current) / name
            if path.is_symlink():
                continue
            try:
                size = path.stat().st_size
            except OSError:
                continue
            total += size
            if total > max_bytes:
                raise SecurityError(f"Repository exceeds the {max_bytes // (1024 * 1024)} MB inspection limit.")
            files.append(path.relative_to(root).as_posix())
            if len(files) > max_files:
                raise SecurityError(f"Repository exceeds the {max_files} file inspection limit.")
    return total, tuple(files)


@contextmanager
def clone_public_repository(repo_url: str) -> Iterator[RepositorySnapshot]:
    clone_url, slug = normalize_github_url(repo_url)
    temp_root = Path(tempfile.mkdtemp(prefix="repo-rescue-clone-"))
    target = temp_root / "repository"
    try:
        if shutil.which("git") is not None:
            result = _run_git(
                ["clone", "--depth", "1", "--filter=blob:none", "--no-tags", "--single-branch", clone_url, str(target)],
                timeout=90,
            )
            if result.returncode != 0:
                raise SecurityError(f"Unable to clone public repository: {result.stderr.strip()[:500]}")
            commit_result = _run_git(["rev-parse", "HEAD"], cwd=target)
            if commit_result.returncode != 0:
                raise SecurityError("Repository was cloned but its commit could not be identified.")
            commit = commit_result.stdout.strip()
        else:
            try:
                porcelain.clone(clone_url, target=str(target), depth=1)
                commit = Repo(str(target)).head().decode("ascii")
            except Exception as exc:  # Dulwich exposes multiple transport exception types.
                raise SecurityError(f"Unable to clone public repository: {str(exc)[:500]}") from exc
        total, files = inventory(target)
        yield RepositorySnapshot(
            path=target,
            slug=slug,
            source_url=clone_url.removesuffix(".git"),
            commit=commit,
            total_bytes=total,
            files=files,
        )
    finally:
        shutil.rmtree(temp_root, ignore_errors=True)
