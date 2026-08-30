from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from repo_rescue.repository import _git_tree_inventory, clone_public_repository
from repo_rescue.security import SecurityError


def _completed(args: list[str], *, returncode: int = 0, stdout: str = "", stderr: str = "") -> subprocess.CompletedProcess[str]:
    return subprocess.CompletedProcess(args, returncode, stdout=stdout, stderr=stderr)


def test_git_tree_inventory_enforces_file_limit_before_checkout(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    tree = "".join(
        f"100644 blob {'a' * 40} 1\tfile-{index}.py\0"
        for index in range(3)
    )
    monkeypatch.setattr(
        "repo_rescue.repository._run_git",
        lambda args, **kwargs: _completed(args, stdout=tree),
    )

    with pytest.raises(SecurityError, match="2 file inspection limit"):
        _git_tree_inventory(tmp_path, "a" * 40, max_files=2, max_bytes=100)


def test_git_tree_inventory_enforces_blob_size_limit_before_checkout(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    tree = f"100644 blob {'a' * 40} 101\tlarge.bin\0"
    monkeypatch.setattr(
        "repo_rescue.repository._run_git",
        lambda args, **kwargs: _completed(args, stdout=tree),
    )

    with pytest.raises(SecurityError, match="0 MB inspection limit"):
        _git_tree_inventory(tmp_path, "a" * 40, max_files=5_000, max_bytes=100)


def test_git_clone_checks_tree_before_materializing_blobs(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    commit = "a" * 40
    events: list[str] = []

    def fake_run_git(args: list[str], *, cwd: Path | None = None, timeout: int = 60) -> subprocess.CompletedProcess[str]:
        if args[0] == "clone":
            events.append("clone")
            Path(args[-1]).mkdir(parents=True)
            assert "--filter=blob:none" in args
            assert "--no-checkout" in args
            return _completed(args)
        if args[:2] == ["rev-parse", "HEAD"]:
            events.append("rev-parse")
            return _completed(args, stdout=f"{commit}\n")
        if args[0] == "ls-tree":
            events.append("tree-check")
            assert cwd is not None
            assert not (cwd / "app.py").exists()
            return _completed(args, stdout=f"100644 blob {'b' * 40} 12\tapp.py\0")
        if args[0] == "checkout":
            events.append("checkout")
            assert cwd is not None
            (cwd / "app.py").write_text("print('ok')\n", encoding="utf-8")
            return _completed(args)
        raise AssertionError(f"unexpected git call: {args}")

    monkeypatch.setattr("repo_rescue.repository.shutil.which", lambda executable: "git")
    monkeypatch.setattr("repo_rescue.repository._run_git", fake_run_git)

    with clone_public_repository("https://github.com/example/project") as snapshot:
        assert snapshot.commit == commit
        assert snapshot.files == ("app.py",)

    assert events == ["clone", "rev-parse", "tree-check", "checkout"]


def test_git_clone_does_not_expose_provider_stderr(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def failed_clone(args: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
        return _completed(
            args,
            returncode=128,
            stderr="vendor fatal at C:\\Users\\private-user\\repository using provider-tenant-7",
        )

    monkeypatch.setattr("repo_rescue.repository.shutil.which", lambda executable: "git")
    monkeypatch.setattr("repo_rescue.repository._run_git", failed_clone)

    with pytest.raises(SecurityError) as caught:
        with clone_public_repository("https://github.com/example/project"):
            pass

    assert str(caught.value) == "Unable to clone the public repository safely."
