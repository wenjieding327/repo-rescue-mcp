from __future__ import annotations

import re
import threading
from typing import Any

import pytest

from repo_rescue.jobs import RepairJobManager
from repo_rescue.security import SecurityError
from repo_rescue.server import _error


def _wait_for_terminal(manager: RepairJobManager, job_id: str) -> dict[str, Any]:
    result = manager.get(job_id, wait_seconds=2)
    assert result["terminal"] is True
    return result


def test_job_ids_are_unguessable_and_results_are_retrievable() -> None:
    manager = RepairJobManager(ttl_seconds=60)
    try:
        first = manager.start("prepare_github_repair", lambda: {"ok": True, "value": 1}, on_error=_error)
        second = manager.start("prepare_github_repair", lambda: {"ok": True, "value": 2}, on_error=_error)

        assert first["job_id"] != second["job_id"]
        assert re.fullmatch(r"[A-Za-z0-9_-]{43}", first["job_id"])
        assert "result" not in first
        assert _wait_for_terminal(manager, first["job_id"])["result"] == {"ok": True, "value": 1}
        assert _wait_for_terminal(manager, second["job_id"])["result"] == {"ok": True, "value": 2}
    finally:
        manager.close()


def test_jobs_execute_with_single_concurrency() -> None:
    manager = RepairJobManager(ttl_seconds=60)
    first_started = threading.Event()
    release_first = threading.Event()
    state_lock = threading.Lock()
    active = 0
    maximum_active = 0

    def task(*, blocks: bool) -> dict[str, Any]:
        nonlocal active, maximum_active
        with state_lock:
            active += 1
            maximum_active = max(maximum_active, active)
        if blocks:
            first_started.set()
            assert release_first.wait(2)
        with state_lock:
            active -= 1
        return {"ok": True}

    try:
        first = manager.start("prepare_github_repair", lambda: task(blocks=True), on_error=_error)
        assert first_started.wait(1)
        second = manager.start("verify_github_patch", lambda: task(blocks=False), on_error=_error)

        assert manager.get(second["job_id"])["status"] == "queued"
        release_first.set()
        _wait_for_terminal(manager, first["job_id"])
        _wait_for_terminal(manager, second["job_id"])
        assert maximum_active == 1
    finally:
        release_first.set()
        manager.close()


def test_completed_jobs_expire_after_ttl() -> None:
    now = [100.0]
    manager = RepairJobManager(ttl_seconds=5, clock=lambda: now[0])
    try:
        started = manager.start("prepare_github_repair", lambda: {"ok": True}, on_error=_error)
        _wait_for_terminal(manager, started["job_id"])

        now[0] += 5
        with pytest.raises(SecurityError, match="Unknown or expired"):
            manager.get(started["job_id"])
    finally:
        manager.close()


def test_job_exception_is_redacted_before_storage() -> None:
    manager = RepairJobManager(ttl_seconds=60)

    def fail() -> dict[str, Any]:
        raise RuntimeError("private tenant at C:\\Users\\secret-user\\repository")

    try:
        started = manager.start("prepare_github_repair", fail, on_error=_error)
        completed = _wait_for_terminal(manager, started["job_id"])

        assert completed["status"] == "failed"
        assert completed["result"] == {
            "ok": False,
            "error_type": "InternalError",
            "message": "The operation could not be completed safely.",
        }
        assert "secret-user" not in repr(completed)
    finally:
        manager.close()


def test_explicit_unsuccessful_result_marks_job_failed() -> None:
    manager = RepairJobManager(ttl_seconds=60)
    try:
        started = manager.start(
            "prepare_github_repair",
            lambda: {"ok": False, "error_type": "ValueError", "message": "Rejected."},
            on_error=_error,
        )
        completed = _wait_for_terminal(manager, started["job_id"])

        assert completed["status"] == "failed"
        assert completed["result"]["ok"] is False
    finally:
        manager.close()


def test_job_capacity_counts_only_queued_or_running_work() -> None:
    release = threading.Event()
    manager = RepairJobManager(ttl_seconds=60, max_jobs=1)
    try:
        first = manager.start(
            "prepare_github_repair",
            lambda: ({"ok": True} if release.wait(2) else {"ok": False}),
            on_error=_error,
        )

        with pytest.raises(ValueError, match="capacity is temporarily full"):
            manager.start("prepare_github_repair", lambda: {"ok": True}, on_error=_error)

        release.set()
        _wait_for_terminal(manager, first["job_id"])
        replacement = manager.start("prepare_github_repair", lambda: {"ok": True}, on_error=_error)
        assert _wait_for_terminal(manager, replacement["job_id"])["status"] == "succeeded"
    finally:
        release.set()
        manager.close()


def test_completed_result_cache_evicts_oldest_without_blocking_new_work() -> None:
    manager = RepairJobManager(ttl_seconds=60, max_jobs=1, max_results=1)
    try:
        first = manager.start("prepare_github_repair", lambda: {"ok": True, "value": 1}, on_error=_error)
        _wait_for_terminal(manager, first["job_id"])
        second = manager.start("prepare_github_repair", lambda: {"ok": True, "value": 2}, on_error=_error)
        assert _wait_for_terminal(manager, second["job_id"])["result"]["value"] == 2

        with pytest.raises(SecurityError, match="Unknown or expired"):
            manager.get(first["job_id"])
    finally:
        manager.close()


def test_job_error_handler_failure_uses_fixed_fallback() -> None:
    manager = RepairJobManager(ttl_seconds=60)

    def fail_task() -> dict[str, Any]:
        raise RuntimeError("sensitive")

    def fail_handler(_exc: Exception) -> dict[str, Any]:
        raise RuntimeError("also sensitive")

    try:
        started = manager.start("prepare_github_repair", fail_task, on_error=fail_handler)
        completed = _wait_for_terminal(manager, started["job_id"])
        assert completed["result"] == {
            "ok": False,
            "error_type": "InternalError",
            "message": "The operation could not be completed safely.",
        }
    finally:
        manager.close()


@pytest.mark.parametrize("wait_seconds", [-1, 20.001, float("inf"), float("nan"), True])
def test_job_poll_wait_is_bounded(wait_seconds: float) -> None:
    manager = RepairJobManager(ttl_seconds=60)
    try:
        with pytest.raises(ValueError, match="between 0 and 20"):
            manager.get("A" * 43, wait_seconds=wait_seconds)
    finally:
        manager.close()


def test_unknown_and_malformed_job_ids_share_one_error() -> None:
    manager = RepairJobManager(ttl_seconds=60)
    try:
        with pytest.raises(SecurityError) as malformed:
            manager.get("1")
        with pytest.raises(SecurityError) as unknown:
            manager.get("A" * 43)

        assert str(malformed.value) == str(unknown.value) == "Unknown or expired repair job."
    finally:
        manager.close()
