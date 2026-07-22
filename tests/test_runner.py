import pytest

from repo_rescue.runner import _safe_dependencies
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

