from __future__ import annotations

import subprocess

import pytest

from repo_rescue.security import SecurityError
from repo_rescue import server
from repo_rescue.server import _error


def test_controlled_errors_are_bounded_and_redacted() -> None:
    secret = "do-not-expose"
    payload = _error(
        SecurityError(
            f"Rejected token={secret} at C:\\Users\\private-user\\repository and /tmp/private-run. "
            + ("x" * 2_000)
        )
    )

    assert payload["error_type"] == "SecurityError"
    assert "token=[REDACTED]" in payload["message"]
    assert secret not in payload["message"]
    assert "private-user" not in payload["message"]
    assert "/tmp/private-run" not in payload["message"]
    assert len(payload["message"]) < 1_100


def test_validation_error_keeps_safe_actionable_message() -> None:
    payload = _error(ValueError("max_attempts must be between 1 and 3."))

    assert payload == {
        "ok": False,
        "error_type": "ValueError",
        "message": "max_attempts must be between 1 and 3.",
    }


@pytest.mark.parametrize(
    "exc",
    [
        OSError("[WinError 5] denied: C:\\Users\\private-user\\repository"),
        RuntimeError("Provider SDK failed for tenant private-tenant at /srv/repo"),
        subprocess.CalledProcessError(
            1,
            ["git", "clone", "https://provider.invalid/private"],
            stderr="fatal: /home/private-user/repository",
        ),
    ],
)
def test_internal_errors_use_stable_generic_contract(exc: Exception) -> None:
    payload = _error(exc)

    assert payload == {
        "ok": False,
        "error_type": "InternalError",
        "message": "The operation could not be completed safely.",
    }


@pytest.mark.parametrize(
    "exc",
    [
        TimeoutError("C:\\Users\\private-user\\repository timed out"),
        subprocess.TimeoutExpired(["vendor-cli", "/srv/private"], 30),
    ],
)
def test_timeout_errors_use_stable_generic_contract(exc: Exception) -> None:
    payload = _error(exc)

    assert payload == {
        "ok": False,
        "error_type": "TimeoutError",
        "message": "The operation timed out before it could complete.",
    }


def test_inspection_converts_git_timeout_to_controlled_response(monkeypatch: pytest.MonkeyPatch) -> None:
    def fail_clone(_repo_url: str):
        raise subprocess.TimeoutExpired(["git", "clone"], 90)

    monkeypatch.setattr(server, "clone_public_repository", fail_clone)

    payload = server.inspect_github_project("https://github.com/example/project")

    assert payload == {
        "ok": False,
        "error_type": "TimeoutError",
        "message": "The operation timed out before it could complete.",
    }
