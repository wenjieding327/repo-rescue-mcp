from __future__ import annotations

import math
import re
import secrets
import threading
import time
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any

from .security import SecurityError


JobResult = dict[str, Any]
JobOperation = Callable[[], JobResult]
JobErrorHandler = Callable[[Exception], JobResult]

_JOB_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{43}$")
_TERMINAL_STATUSES = frozenset({"succeeded", "failed"})


@dataclass
class _RepairJob:
    job_id: str
    operation: str
    created_at: float
    status: str = "queued"
    result: JobResult | None = None
    completed_at: float | None = None
    done: threading.Event = field(default_factory=threading.Event)


class RepairJobManager:
    """Run long repair operations serially and retain bounded-lived results.

    The manager is intentionally process-local. A cryptographically random ID
    is the only lookup capability exposed to callers; there is no list API.
    Completed jobs are removed lazily after ``ttl_seconds``.
    """

    def __init__(
        self,
        *,
        ttl_seconds: float = 900.0,
        max_wait_seconds: float = 20.0,
        max_jobs: int = 32,
        max_results: int = 64,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        if not math.isfinite(ttl_seconds) or ttl_seconds <= 0:
            raise ValueError("ttl_seconds must be a positive finite number.")
        if not math.isfinite(max_wait_seconds) or max_wait_seconds <= 0:
            raise ValueError("max_wait_seconds must be a positive finite number.")
        if isinstance(max_jobs, bool) or not isinstance(max_jobs, int) or max_jobs <= 0:
            raise ValueError("max_jobs must be a positive integer.")
        if isinstance(max_results, bool) or not isinstance(max_results, int) or max_results <= 0:
            raise ValueError("max_results must be a positive integer.")

        self._ttl_seconds = float(ttl_seconds)
        self._max_wait_seconds = float(max_wait_seconds)
        self._max_jobs = max_jobs
        self._max_results = max_results
        self._clock = clock
        self._jobs: dict[str, _RepairJob] = {}
        self._lock = threading.Lock()
        self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="repo-rescue-job")

    def start(
        self,
        operation: str,
        task: JobOperation,
        *,
        on_error: JobErrorHandler,
    ) -> JobResult:
        if not operation or len(operation) > 100:
            raise ValueError("operation must be between 1 and 100 characters.")

        job_id = secrets.token_urlsafe(32)
        job = _RepairJob(job_id=job_id, operation=operation, created_at=self._clock())
        with self._lock:
            self._purge_expired_locked()
            active_jobs = sum(job.status not in _TERMINAL_STATUSES for job in self._jobs.values())
            if active_jobs >= self._max_jobs:
                raise ValueError("Repair job capacity is temporarily full. Try again later.")
            # A collision is cryptographically implausible, but never overwrite
            # a live capability if a provider or test double returns one.
            while job_id in self._jobs:
                job_id = secrets.token_urlsafe(32)
                job.job_id = job_id
            self._jobs[job_id] = job
            accepted = self._snapshot(job)

        try:
            self._executor.submit(self._execute, job, task, on_error)
        except Exception:
            with self._lock:
                self._jobs.pop(job_id, None)
            raise
        return accepted

    def get(self, job_id: str, *, wait_seconds: float = 0.0) -> JobResult:
        self._validate_wait_seconds(wait_seconds)
        if not isinstance(job_id, str) or _JOB_ID_PATTERN.fullmatch(job_id) is None:
            raise SecurityError("Unknown or expired repair job.")

        with self._lock:
            self._purge_expired_locked()
            job = self._jobs.get(job_id)
        if job is None:
            raise SecurityError("Unknown or expired repair job.")

        if wait_seconds:
            job.done.wait(wait_seconds)

        with self._lock:
            # Keep the record obtained with the caller's valid capability long
            # enough to return a just-completed result. The next access performs
            # normal TTL collection.
            return self._snapshot(job)

    def close(self) -> None:
        """Wait for submitted work and release the worker thread."""
        self._executor.shutdown(wait=True)

    def _execute(self, job: _RepairJob, task: JobOperation, on_error: JobErrorHandler) -> None:
        with self._lock:
            job.status = "running"

        try:
            result = task()
            if not isinstance(result, dict):
                raise TypeError("Repair job returned an invalid result.")
        except Exception as exc:
            result = self._safe_error(on_error, exc)
            status = "failed"
        else:
            status = "failed" if result.get("ok") is False else "succeeded"

        with self._lock:
            job.result = result
            job.status = status
            job.completed_at = self._clock()
            job.done.set()
            self._trim_completed_locked()

    @staticmethod
    def _safe_error(on_error: JobErrorHandler, exc: Exception) -> JobResult:
        try:
            payload = on_error(exc)
            if isinstance(payload, dict):
                return payload
        except Exception:
            pass
        return {
            "ok": False,
            "error_type": "InternalError",
            "message": "The operation could not be completed safely.",
        }

    def _validate_wait_seconds(self, wait_seconds: float) -> None:
        if (
            isinstance(wait_seconds, bool)
            or not isinstance(wait_seconds, (int, float))
            or not math.isfinite(wait_seconds)
            or wait_seconds < 0
            or wait_seconds > self._max_wait_seconds
        ):
            maximum = int(self._max_wait_seconds) if self._max_wait_seconds.is_integer() else self._max_wait_seconds
            raise ValueError(f"wait_seconds must be between 0 and {maximum}.")

    def _purge_expired_locked(self) -> None:
        now = self._clock()
        expired = [
            job_id
            for job_id, job in self._jobs.items()
            if job.completed_at is not None and now - job.completed_at >= self._ttl_seconds
        ]
        for job_id in expired:
            del self._jobs[job_id]

    def _trim_completed_locked(self) -> None:
        """Bound retained results without letting terminal jobs block new work."""
        completed = sorted(
            (job for job in self._jobs.values() if job.status in _TERMINAL_STATUSES),
            key=lambda job: (job.completed_at if job.completed_at is not None else job.created_at, job.created_at),
        )
        for job in completed[: max(0, len(completed) - self._max_results)]:
            self._jobs.pop(job.job_id, None)

    @staticmethod
    def _snapshot(job: _RepairJob) -> JobResult:
        payload: JobResult = {
            "job_id": job.job_id,
            "operation": job.operation,
            "status": job.status,
            "terminal": job.status in _TERMINAL_STATUSES,
            "poll_tool": "get_repair_job",
        }
        if job.status in _TERMINAL_STATUSES:
            payload["result"] = job.result
        return payload
