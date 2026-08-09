from __future__ import annotations

import difflib
import hashlib
import json
import shutil
import tempfile
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

from .analysis import analyze_snapshot
from .repair import (
    DeterministicDemoRepairAgent,
    OpenAIRepairAgent,
    RepairAgent,
    apply_repair_proposal,
)
from .repository import RepositorySnapshot, clone_public_repository, inventory
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
            source_url=source.as_uri(),
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
            f"- Before exit code: `{baseline.get('execution', {}).get('exit_code')}`",
            f"- After exit code: `{final.get('execution', {}).get('exit_code')}`",
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
    evidence_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
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
) -> dict[str, Any]:
    if not 1 <= max_attempts <= 5:
        raise ValueError("max_attempts must be between 1 and 5.")
    run_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:8]
    started_at = _now()
    baseline = verifier.verify(snapshot, analysis)
    attempts: list[dict[str, Any]] = []
    originals: dict[str, str] = {}
    final_verification = baseline
    status = "already_passing" if baseline.get("verified") else "reproduction_failed"

    if not baseline.get("verified") and baseline.get("status") == "verification_failed":
        status = "repair_failed"
        for attempt_number in range(1, max_attempts + 1):
            try:
                proposal = agent.propose(
                    snapshot,
                    issue=issue,
                    verification=final_verification,
                    attempt=attempt_number,
                )
                applied = apply_repair_proposal(snapshot.path, proposal)
                for item in applied:
                    originals.setdefault(item["path"], item.pop("before_content"))
                verification = verifier.verify(snapshot, analysis)
                if verification.get("command") != baseline.get("command"):
                    raise RuntimeError("Verifier command changed between baseline and repaired runs.")
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
                    status = "verified_repair"
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
    verified_repair = bool(
        status == "verified_repair"
        and not baseline.get("verified")
        and final_verification.get("verified")
        and patch
        and baseline.get("command") == final_verification.get("command")
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
        "evidence_boundary": (
            "A verified repair means the pinned original failed and the patched checkout passed the exact same "
            "recorded command. It does not prove every repository behavior, official demo, or paper metric."
        ),
    }
    attestation_payload = "|".join(
        [
            report["run_id"],
            snapshot.commit,
            str(baseline.get("command")),
            str(baseline.get("execution", {}).get("exit_code")),
            str(final_verification.get("execution", {}).get("exit_code")),
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
