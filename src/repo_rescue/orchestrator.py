from __future__ import annotations

import difflib
import hashlib
import json
import os
import re
import shutil
import tempfile
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

from packaging.requirements import InvalidRequirement, Requirement
from packaging.utils import canonicalize_name

from .analysis import analyze_snapshot
from .repair import (
    DeterministicDemoRepairAgent,
    OpenAIRepairAgent,
    RepairAgent,
    apply_repair_proposal,
)
from .repository import RepositorySnapshot, clone_public_repository, inventory
from .security import SecurityError, normalize_github_url, require_execution_allowed
from .verifier import DockerRepositoryVerifier, EphemeralVenvVerifier, Verifier


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _tree_sha256(root: Path, files: tuple[str, ...]) -> str:
    digest = hashlib.sha256()
    for relative in files:
        path = root / Path(relative)
        digest.update(relative.encode("utf-8"))
        digest.update(b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


@contextmanager
def copied_local_repository(source: Path, slug: str = "builtin/interview-demo") -> Iterator[RepositorySnapshot]:
    source = source.resolve()
    if not source.is_dir():
        raise ValueError(f"Local demo source does not exist: {source}")
    with tempfile.TemporaryDirectory(prefix="repo-rescue-local-") as temp:
        project = Path(temp) / "project"
        shutil.copytree(
            source,
            project,
            ignore=shutil.ignore_patterns(".git", ".venv", "__pycache__", ".pytest_cache"),
        )
        total, files = inventory(project)
        yield RepositorySnapshot(
            path=project,
            slug=slug,
            source_url="builtin://interview-demo" if slug == "builtin/interview-demo" else source.as_uri(),
            commit=_tree_sha256(project, files),
            total_bytes=total,
            files=files,
        )


def _unified_patch(root: Path, originals: dict[str, str]) -> str:
    chunks: list[str] = []
    for relative in sorted(originals):
        before = originals[relative]
        after = (root / Path(relative)).read_text(encoding="utf-8", errors="replace")
        chunks.extend(
            difflib.unified_diff(
                before.splitlines(keepends=True),
                after.splitlines(keepends=True),
                fromfile=f"a/{relative}",
                tofile=f"b/{relative}",
            )
        )
    return "".join(chunks)


def _report_markdown(report: dict[str, Any]) -> str:
    baseline = report["baseline"]
    final = report["final_verification"]
    changed = ", ".join(report["changed_files"]) or "none"
    result = "VERIFIED REPAIR" if report["verified_repair"] else report["status"].upper()
    return "\n".join(
        [
            "# RepoRescue Evidence Report",
            "",
            f"- Result: **{result}**",
            f"- Run ID: `{report['run_id']}`",
            f"- Repository: `{report['repository']['slug']}`",
            f"- Commit: `{report['repository']['commit']}`",
            f"- Repair Agent: `{report['repair_agent']}`",
            f"- Changed files: `{changed}`",
            "",
            "## Before and after",
            "",
            f"- Command: `{baseline.get('command')}`",
            f"- Before status: `{baseline.get('status')}`",
            f"- After status: `{final.get('status')}`",
            f"- Before install exit code: `{_phase_exit_code(baseline, 'install')}`",
            f"- After install exit code: `{_phase_exit_code(final, 'install')}`",
            f"- Before exit code: `{_exit_code(baseline)}`",
            f"- After exit code: `{_exit_code(final)}`",
            f"- Same command: `{baseline.get('command') == final.get('command')}`",
            "",
            "## Evidence boundary",
            "",
            report["evidence_boundary"],
            "",
            "## Artifacts",
            "",
            "- `repair.patch` — exact source diff",
            "- `evidence.json` — commands, exit codes, bounded logs, hashes, and attempts",
            "- `report.md` — this readable summary",
            "",
        ]
    )


def _exit_code(verification: dict[str, Any]) -> Any:
    execution = verification.get("execution")
    if isinstance(execution, dict):
        execution_exit = execution.get("exit_code")
        if execution_exit is not None:
            return execution_exit
    install = verification.get("install")
    if isinstance(install, dict):
        return install.get("exit_code")
    return None


_DISTRIBUTION_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")


def _dependency_names(analysis: dict[str, Any]) -> set[str]:
    names: set[str] = set()
    for value in analysis.get("execution_dependencies", []):
        try:
            names.add(canonicalize_name(Requirement(str(value)).name))
        except InvalidRequirement as exc:
            raise SecurityError(f"Invalid analyzed dependency: {value}") from exc
    return names


def _allowed_additional_dependency_names() -> set[str]:
    names: set[str] = set()
    for raw in os.getenv("REPO_RESCUE_ALLOWED_ADDITIONAL_DEPENDENCIES", "").split(","):
        candidate = raw.strip()
        if not candidate:
            continue
        if not _DISTRIBUTION_NAME.fullmatch(candidate):
            raise SecurityError(
                "REPO_RESCUE_ALLOWED_ADDITIONAL_DEPENDENCIES must contain plain distribution names."
            )
        names.add(canonicalize_name(candidate))
    return names


def _require_dependency_names_allowed(initial: set[str], updated_analysis: dict[str, Any]) -> None:
    added = _dependency_names(updated_analysis) - initial - _allowed_additional_dependency_names()
    if added:
        display = ", ".join(sorted(added))
        raise SecurityError(
            "Repair Agent may not add new dependency distributions without administrator approval: " + display
        )


def _require_pytest_coverage_not_weakened(
    baseline: dict[str, Any],
    verification: dict[str, Any],
    minimum_collected: int,
) -> bool:
    if not verification.get("verified"):
        return True
    before_execution = baseline.get("execution")
    after_execution = verification.get("execution")
    before = before_execution.get("pytest_attestation") if isinstance(before_execution, dict) else None
    after = after_execution.get("pytest_attestation") if isinstance(after_execution, dict) else None
    pytest_scope = bool(
        baseline.get("verification_scope") == "pytest_suite"
        or verification.get("verification_scope") == "pytest_suite"
        or isinstance(before, dict)
        or isinstance(after, dict)
    )
    if not pytest_scope:
        return True
    if not isinstance(after, dict) or not after.get("completed"):
        raise RuntimeError("Repaired pytest run did not return trusted completion evidence.")
    after_collected = int(after.get("collected", 0))
    after_skipped = int(after.get("skipped", 0))
    if after_collected < minimum_collected:
        raise RuntimeError(
            "Repaired pytest run collected fewer tests than the repository's initial static test modules."
        )
    if not isinstance(before, dict) or not before.get("completed"):
        if after_skipped > 0:
            raise RuntimeError(
                "Baseline pytest coverage was unavailable, so a repaired run with skipped tests cannot be verified."
            )
        return False
    if after_collected < int(before.get("collected", 0)):
        raise RuntimeError("Repaired pytest run collected fewer tests than the baseline.")
    if after_skipped > int(before.get("skipped", 0)):
        raise RuntimeError("Repaired pytest run increased the skipped-test count.")
    return True


def _phase_exit_code(verification: dict[str, Any], phase_name: str) -> Any:
    phase = verification.get(phase_name)
    return phase.get("exit_code") if isinstance(phase, dict) else None


def _write_artifacts(report: dict[str, Any], patch: str, artifacts_root: Path) -> dict[str, str]:
    run_dir = artifacts_root.resolve() / report["run_id"]
    run_dir.mkdir(parents=True, exist_ok=False)
    patch_path = run_dir / "repair.patch"
    evidence_path = run_dir / "evidence.json"
    markdown_path = run_dir / "report.md"
    patch_path.write_text(patch, encoding="utf-8", newline="")
    paths = {
        "directory": str(run_dir),
        "patch": str(patch_path),
        "evidence": str(evidence_path),
        "report": str(markdown_path),
    }
    report["artifacts"] = paths
    public_artifacts = {
        "run_id": report["run_id"],
        "available": ["patch", "evidence", "report"],
        "retrieval_tool": "get_repair_artifact",
    }
    evidence_report = {**report, "artifacts": public_artifacts}
    evidence_path.write_text(json.dumps(evidence_report, ensure_ascii=False, indent=2), encoding="utf-8")
    markdown_path.write_text(_report_markdown(report), encoding="utf-8", newline="")
    return paths


def run_repair_loop(
    snapshot: RepositorySnapshot,
    analysis: dict[str, Any],
    *,
    issue: str,
    agent: RepairAgent,
    verifier: Verifier,
    artifacts_root: Path,
    max_attempts: int = 2,
    initial_verification: dict[str, Any] | None = None,
) -> dict[str, Any]:
    if not 1 <= max_attempts <= 5:
        raise ValueError("max_attempts must be between 1 and 5.")
    run_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:8]
    started_at = _now()
    baseline = initial_verification if initial_verification is not None else verifier.verify(snapshot, analysis)
    initial_dependency_names = _dependency_names(analysis)
    initial_static_test_module_count = int(analysis.get("static_test_module_count", 0))
    attempts: list[dict[str, Any]] = []
    originals: dict[str, str] = {}
    final_verification = baseline
    status = "already_passing" if baseline.get("verified") else "reproduction_failed"

    if not baseline.get("verified") and baseline.get("status") in {"verification_failed", "dependency_install_failed"}:
        status = "repair_failed"
        for attempt_number in range(1, max_attempts + 1):
            try:
                proposal = agent.propose(
                    snapshot,
                    issue=issue,
                    verification=final_verification,
                    attempt=attempt_number,
                )
                applied = apply_repair_proposal(snapshot, proposal)
                for item in applied:
                    originals.setdefault(item["path"], item.pop("before_content"))
                analysis = analyze_snapshot(snapshot)
                _require_dependency_names_allowed(initial_dependency_names, analysis)
                verification = verifier.verify(snapshot, analysis)
                if verification.get("command") != baseline.get("command"):
                    raise RuntimeError("Verifier command changed between baseline and repaired runs.")
                pytest_coverage_comparable = _require_pytest_coverage_not_weakened(
                    baseline,
                    verification,
                    initial_static_test_module_count,
                )
                attempts.append(
                    {
                        "attempt": attempt_number,
                        "analysis": proposal.analysis,
                        "changes": applied,
                        "verification": verification,
                    }
                )
                final_verification = verification
                if verification.get("verified"):
                    if not pytest_coverage_comparable:
                        status = "repair_tests_passed_uncompared"
                    else:
                        status = (
                            "verified_repair"
                            if verification.get("repair_evidence_eligible", True)
                            else "repair_smoke_passed"
                        )
                    break
            except Exception as exc:
                attempts.append(
                    {
                        "attempt": attempt_number,
                        "error_type": type(exc).__name__,
                        "error": str(exc),
                    }
                )
                status = "repair_agent_failed"
                break

    patch = _unified_patch(snapshot.path, originals) if originals else ""
    patch_sha256 = hashlib.sha256(patch.encode("utf-8")).hexdigest()
    if status == "verified_repair" and not patch:
        status = "repair_failed"
    verified_repair = bool(
        status == "verified_repair"
        and not baseline.get("verified")
        and final_verification.get("verified")
        and final_verification.get("repair_evidence_eligible", True)
        and patch
        and baseline.get("command") == final_verification.get("command")
    )
    if status == "repair_tests_passed_uncompared":
        evidence_boundary = (
            "The repaired checkout passed pytest, but dependency installation prevented a trustworthy baseline "
            "test-count comparison. This is intentionally not a verified repair."
        )
    else:
        evidence_boundary = (
            "A verified repair means the pinned original failed and the patched checkout passed the exact same "
            "recorded command without reducing the measured pytest scope. It does not prove every repository "
            "behavior, official demo, or paper metric. Semantic verification assumes the administrator-allow-listed "
            "test harness does not deliberately spoof pytest internals."
        )
    report: dict[str, Any] = {
        "schema_version": "1.0",
        "run_id": run_id,
        "status": status,
        "verified_repair": verified_repair,
        "started_at": started_at,
        "completed_at": _now(),
        "issue": issue,
        "repository": {
            "slug": snapshot.slug,
            "url": snapshot.source_url,
            "commit": snapshot.commit,
            "file_count": len(snapshot.files),
            "total_bytes": snapshot.total_bytes,
        },
        "repair_agent": agent.name,
        "verifier_backend": baseline.get("backend"),
        "baseline": baseline,
        "attempts": attempts,
        "final_verification": final_verification,
        "changed_files": sorted(originals),
        "patch_sha256": patch_sha256,
        "evidence_boundary": evidence_boundary,
    }
    attestation_payload = "|".join(
        [
            report["run_id"],
            snapshot.commit,
            str(baseline.get("command")),
            str(_exit_code(baseline)),
            str(_exit_code(final_verification)),
            patch_sha256,
        ]
    )
    report["attestation_sha256"] = hashlib.sha256(attestation_payload.encode("utf-8")).hexdigest()
    _write_artifacts(report, patch, artifacts_root)
    return report


def run_github_repair(
    repo_url: str,
    *,
    issue: str = "",
    artifacts_root: Path,
    max_attempts: int = 2,
    model: str | None = None,
) -> dict[str, Any]:
    _, slug = normalize_github_url(repo_url)
    require_execution_allowed(slug)
    with clone_public_repository(repo_url) as snapshot:
        analysis = analyze_snapshot(snapshot)
        return run_repair_loop(
            snapshot,
            analysis,
            issue=issue,
            agent=OpenAIRepairAgent(model=model),
            verifier=DockerRepositoryVerifier(),
            artifacts_root=artifacts_root,
            max_attempts=max_attempts,
        )


def run_builtin_demo(*, artifacts_root: Path) -> dict[str, Any]:
    source = Path(__file__).resolve().parent / "demo_project"
    with copied_local_repository(source) as snapshot:
        analysis = analyze_snapshot(snapshot)
        verifier = EphemeralVenvVerifier(snapshot.path.parent)
        return run_repair_loop(
            snapshot,
            analysis,
            issue="divide(8, 2) should return 4, but the seeded implementation is wrong",
            agent=DeterministicDemoRepairAgent(),
            verifier=verifier,
            artifacts_root=artifacts_root,
            max_attempts=1,
        )
