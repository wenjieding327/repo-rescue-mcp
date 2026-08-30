from __future__ import annotations

import asyncio
import subprocess
import threading
import time

import pytest

from repo_rescue.security import SecurityError
from repo_rescue import server
from repo_rescue.jobs import RepairJobManager
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


@pytest.fixture
def isolated_repair_jobs(monkeypatch: pytest.MonkeyPatch):
    manager = RepairJobManager(ttl_seconds=60)
    monkeypatch.setenv("REPO_RESCUE_ALLOWED_REPOS", "example/project")
    monkeypatch.setattr(server, "_repair_jobs", manager)
    try:
        yield manager
    finally:
        manager.close()


def test_async_prepare_reuses_synchronous_public_result(
    monkeypatch: pytest.MonkeyPatch,
    isolated_repair_jobs: RepairJobManager,
) -> None:
    preparation = {"commit": "a" * 40, "baseline_sha256": "b" * 64}
    monkeypatch.setattr(server, "prepare_repair", lambda *_args, **_kwargs: preparation)

    synchronous = server.prepare_github_repair("https://github.com/example/project")
    started = server.start_prepare_github_repair("https://github.com/example/project")
    completed = asyncio.run(server.get_repair_job(started["job"]["job_id"], wait_seconds=2))

    assert started["ok"] is True
    assert completed["job"]["status"] == "succeeded"
    assert completed["job"]["result"] == synchronous == {"ok": True, "preparation": preparation}


def test_async_verify_reuses_filtered_repair_result(
    monkeypatch: pytest.MonkeyPatch,
    isolated_repair_jobs: RepairJobManager,
) -> None:
    observed: dict[str, object] = {}

    def verify(_repo_url: str, **kwargs):
        observed.update(kwargs)
        return {
            "run_id": "20260830T000000Z-abcdef12",
            "verified_repair": True,
            "artifacts": {"server_path": "C:\\private\\artifacts"},
        }

    monkeypatch.setattr(server, "verify_submitted_github_patch", verify)
    changes = [server.PatchChange(path="src/example.py", content="VALUE = 2\n")]

    started = server.start_verify_github_patch(
        "https://github.com/example/project",
        "a" * 40,
        "b" * 64,
        changes,
        analysis="minimal repair",
    )
    completed = asyncio.run(server.get_repair_job(started["job"]["job_id"], wait_seconds=2))

    result = completed["job"]["result"]
    assert completed["job"]["status"] == "succeeded"
    assert result["repair"]["verified_repair"] is True
    assert result["repair"]["artifacts"] == {
        "run_id": "20260830T000000Z-abcdef12",
        "available": ["patch", "evidence", "report"],
        "retrieval_tool": "get_repair_artifact",
    }
    assert observed["changes"] == [{"path": "src/example.py", "content": "VALUE = 2\n"}]


def test_async_job_failure_uses_mcp_error_contract(
    monkeypatch: pytest.MonkeyPatch,
    isolated_repair_jobs: RepairJobManager,
) -> None:
    def fail(_repo_url: str):
        raise OSError("C:\\Users\\private-user\\repository")

    monkeypatch.setattr(server, "_prepare_github_repair_result", fail)

    started = server.start_prepare_github_repair("https://github.com/example/project")
    completed = asyncio.run(server.get_repair_job(started["job"]["job_id"], wait_seconds=2))

    assert completed["job"]["status"] == "failed"
    assert completed["job"]["result"] == {
        "ok": False,
        "error_type": "InternalError",
        "message": "The operation could not be completed safely.",
    }
    assert "private-user" not in repr(completed)


def test_get_repair_job_rejects_wait_above_platform_limit(
    isolated_repair_jobs: RepairJobManager,
) -> None:
    payload = asyncio.run(server.get_repair_job("A" * 43, wait_seconds=21))

    assert payload == {
        "ok": False,
        "error_type": "ValueError",
        "message": "wait_seconds must be between 0 and 20.",
    }


def test_async_start_returns_controlled_capacity_error(monkeypatch: pytest.MonkeyPatch) -> None:
    release = threading.Event()
    manager = RepairJobManager(ttl_seconds=60, max_jobs=1)
    monkeypatch.setenv("REPO_RESCUE_ALLOWED_REPOS", "example/project")
    monkeypatch.setattr(server, "_repair_jobs", manager)

    def blocked(_repo_url: str) -> dict[str, object]:
        assert release.wait(2)
        return {"ok": True, "preparation": {}}

    monkeypatch.setattr(server, "_prepare_github_repair_result", blocked)
    try:
        first = server.start_prepare_github_repair("https://github.com/example/project")
        second = server.start_prepare_github_repair("https://github.com/example/project")

        assert first["ok"] is True
        assert second == {
            "ok": False,
            "error_type": "ValueError",
            "message": "Repair job capacity is temporarily full. Try again later.",
        }
    finally:
        release.set()
        manager.close()


def test_async_poll_wait_does_not_block_the_event_loop(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    release = threading.Event()
    manager = RepairJobManager(ttl_seconds=60)
    monkeypatch.setattr(server, "_repair_jobs", manager)
    try:
        started = manager.start(
            "prepare_github_repair",
            lambda: ({"ok": True} if release.wait(2) else {"ok": False}),
            on_error=_error,
        )

        async def exercise() -> float:
            poll = asyncio.create_task(server.get_repair_job(started["job_id"], wait_seconds=0.3))
            began = time.monotonic()
            await asyncio.sleep(0.03)
            tick_elapsed = time.monotonic() - began
            await poll
            return tick_elapsed

        assert asyncio.run(exercise()) < 0.15
    finally:
        release.set()
        manager.close()


def test_invalid_async_verify_is_rejected_before_queueing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    manager = RepairJobManager(ttl_seconds=60, max_jobs=1)
    monkeypatch.setenv("REPO_RESCUE_ALLOWED_REPOS", "example/project")
    monkeypatch.setattr(server, "_repair_jobs", manager)
    try:
        payload = server.start_verify_github_patch(
            "https://github.com/example/project",
            "bad-commit",
            "b" * 64,
            [server.PatchChange(path="src/example.py", content="VALUE = 2\n")],
        )
        assert payload["ok"] is False
        assert "40-character SHA" in payload["message"]

        replacement = manager.start(
            "prepare_github_repair",
            lambda: {"ok": True},
            on_error=_error,
        )
        assert manager.get(replacement["job_id"], wait_seconds=2)["status"] == "succeeded"
    finally:
        manager.close()


def test_async_verify_schema_exposes_input_bounds() -> None:
    schema = server.mcp._tool_manager._tools["start_verify_github_patch"].parameters

    assert schema["properties"]["repo_url"]["maxLength"] == 500
    assert schema["properties"]["expected_commit"]["pattern"] == r"^[0-9a-fA-F]{40}$"
    assert schema["properties"]["expected_baseline_sha256"]["pattern"] == r"^[0-9a-fA-F]{64}$"
    assert schema["properties"]["changes"] == {
        "items": {"$ref": "#/$defs/PatchChange"},
        "maxItems": 8,
        "minItems": 1,
        "title": "Changes",
        "type": "array",
    }
    assert schema["properties"]["analysis"]["maxLength"] == 4_000
    assert schema["properties"]["issue"]["maxLength"] == 8_000

    poll_schema = server.mcp._tool_manager._tools["get_repair_job"].parameters["properties"]
    assert poll_schema["job_id"]["minLength"] == poll_schema["job_id"]["maxLength"] == 43
    assert poll_schema["job_id"]["pattern"] == r"^[A-Za-z0-9_-]{43}$"
    assert poll_schema["wait_seconds"]["minimum"] == 0
    assert poll_schema["wait_seconds"]["maximum"] == 20


@pytest.mark.parametrize(
    ("transport", "expected"),
    [
        ("stdio", {"transport": "stdio"}),
        ("streamable-http", {"transport": "streamable-http"}),
    ],
)
def test_main_runs_supported_transport(
    monkeypatch: pytest.MonkeyPatch,
    transport: str,
    expected: dict[str, str],
) -> None:
    calls: list[dict[str, object]] = []
    monkeypatch.setenv("REPO_RESCUE_TRANSPORT", transport)
    monkeypatch.setattr(server.mcp, "run", lambda **kwargs: calls.append(kwargs))

    server.main()

    assert calls == [expected]


def test_main_runs_sse_at_verified_root_paths(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[dict[str, object]] = []
    monkeypatch.setenv("REPO_RESCUE_TRANSPORT", " SSE ")
    monkeypatch.setenv("REPO_RESCUE_SSE_MOUNT_PATH", "/ignored-invalid-prefix")
    monkeypatch.setattr(server.mcp, "run", lambda **kwargs: calls.append(kwargs))

    server.main()

    assert calls == [{"transport": "sse"}]


def test_main_rejects_unknown_transport(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("REPO_RESCUE_TRANSPORT", "websocket")

    with pytest.raises(ValueError, match="streamable-http, sse, or stdio"):
        server.main()
