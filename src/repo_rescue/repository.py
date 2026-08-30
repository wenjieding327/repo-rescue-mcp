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


def _git_tree_inventory(
    root: Path,
    commit: str,
    *,
    max_files: int = 5_000,
    max_bytes: int | None = None,
) -> tuple[int, tuple[str, ...]]:
    """Bound a Git tree using blob metadata before materializing its checkout."""
    if max_bytes is None:
        max_bytes = int(os.getenv("REPO_RESCUE_MAX_REPO_MB", "50")) * 1024 * 1024
    result = _run_git(["ls-tree", "-r", "-l", "-z", commit], cwd=root)
    if result.returncode != 0:
        raise SecurityError("Repository tree metadata could not be inspected safely.")

    total = 0
    files: list[str] = []
    for raw_entry in result.stdout.split("\0"):
        if not raw_entry:
            continue
        try:
            metadata, relative = raw_entry.split("\t", 1)
            _mode, object_type, _object_id, size_text = metadata.split(maxsplit=3)
        except ValueError as exc:
            raise SecurityError("Repository tree metadata was malformed.") from exc
        if object_type != "blob":
            # Submodule commits are not checked out or executed by RepoRescue.
            continue
        try:
            size = int(size_text)
        except ValueError as exc:
            raise SecurityError("Repository blob sizes could not be verified safely.") from exc
        if size < 0:
            raise SecurityError("Repository blob sizes could not be verified safely.")
        total += size
        if total > max_bytes:
            raise SecurityError(f"Repository exceeds the {max_bytes // (1024 * 1024)} MB inspection limit.")
        files.append(relative)
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
                [
                    "clone",
                    "--depth",
                    "1",
                    "--filter=blob:none",
                    "--no-checkout",
                    "--no-tags",
                    "--single-branch",
                    clone_url,
                    str(target),
                ],
                timeout=90,
            )
            if result.returncode != 0:
                raise SecurityError("Unable to clone the public repository safely.")
            commit_result = _run_git(["rev-parse", "HEAD"], cwd=target)
            if commit_result.returncode != 0:
                raise SecurityError("Repository was cloned but its commit could not be identified.")
            commit = commit_result.stdout.strip()
            _git_tree_inventory(target, commit)
            checkout_result = _run_git(["checkout", "--detach", "--force", commit], cwd=target, timeout=90)
            if checkout_result.returncode != 0:
                raise SecurityError("Repository checkout could not be completed safely.")
        else:
            # Fallback boundary: Dulwich currently materializes its checkout
            # during clone, so the same pre-checkout Git tree gate is not
            # available. The post-clone inventory limits below remain enforced.
            try:
                porcelain.clone(clone_url, target=str(target), depth=1)
                commit = Repo(str(target)).head().decode("ascii")
            except Exception as exc:  # Dulwich exposes multiple transport exception types.
                raise SecurityError("Unable to clone the public repository safely.") from exc
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
