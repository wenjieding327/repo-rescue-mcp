from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any

from .analysis import analyze_snapshot
from .orchestrator import run_builtin_demo, run_github_repair
from .repository import clone_public_repository


def _print_json(payload: dict[str, Any]) -> None:
    # JSON mode is a machine interface, so keep stdout ASCII-only. This avoids
    # UnicodeEncodeError on Windows consoles whose active encoding cannot
    # represent repository content, while json.loads restores the exact text.
    print(json.dumps(payload, ensure_ascii=True, indent=2))


def _print_result(report: dict[str, Any], *, as_json: bool) -> None:
    if as_json:
        _print_json(report)
        return
    baseline = report.get("baseline", {})
    final = report.get("final_verification", {})

    def exit_code(verification: dict[str, Any]) -> Any:
        execution = verification.get("execution")
        if isinstance(execution, dict) and execution.get("exit_code") is not None:
            return execution.get("exit_code")
        install = verification.get("install")
        return install.get("exit_code") if isinstance(install, dict) else None

    print("RepoRescue automatic repair loop")
    print(f"result: {report.get('status')}")
    print(f"repository: {report.get('repository', {}).get('slug')}")
    print(f"commit: {report.get('repository', {}).get('commit')}")
    print(f"command: {baseline.get('command')}")
    print(f"before: exit {exit_code(baseline)}")
    print(f"after:  exit {exit_code(final)}")
    print(f"changed: {', '.join(report.get('changed_files', [])) or 'none'}")
    print(f"patch: {report.get('artifacts', {}).get('patch')}")
    print(f"report: {report.get('artifacts', {}).get('report')}")
    print(f"evidence: {report.get('artifacts', {}).get('evidence')}")


def _artifacts_path(value: str) -> Path:
    return Path(value).expanduser().resolve()


def _print_inspection(inspection: dict[str, Any], *, as_json: bool) -> None:
    if as_json:
        _print_json(inspection)
        return
    repository = inspection.get("repository", {})
    print("RepoRescue read-only inspection")
    print(f"repository: {repository.get('slug')}")
    print(f"commit: {repository.get('commit')}")
    print(f"language: {inspection.get('detected_language')}")
    print(f"manifests: {', '.join(inspection.get('manifests', {}).keys()) or 'none'}")
    print(f"suggested command: {(inspection.get('suggested_verification_commands') or [None])[0]}")


def _report_exit_code(report: dict[str, Any]) -> int:
    if report.get("verified_repair") or report.get("status") == "already_passing":
        return 0
    return 1


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="repo-rescue",
        description="Reproduce, repair, verify, and produce patch evidence for Python repositories.",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    demo = subparsers.add_parser("demo", help="Run the deterministic, no-API-key interview demo.")
    demo.add_argument("--artifacts", default="artifacts", type=_artifacts_path)
    demo.add_argument("--json", action="store_true", dest="as_json")

    inspect = subparsers.add_parser("inspect", help="Inspect a public GitHub repository without executing it.")
    inspect.add_argument("repo_url")
    inspect.add_argument("--json", action="store_true", dest="as_json")

    repair = subparsers.add_parser("repair", help="Repair an allow-listed public GitHub repository.")
    repair.add_argument("repo_url")
    repair.add_argument("--issue", default="")
    repair.add_argument("--model", default=os.getenv("REPO_RESCUE_OPENAI_MODEL", "gpt-5.6-terra"))
    repair.add_argument("--max-attempts", type=int, default=2, choices=range(1, 6))
    repair.add_argument("--artifacts", default="artifacts", type=_artifacts_path)
    repair.add_argument("--json", action="store_true", dest="as_json")

    subparsers.add_parser("serve", help="Start the MCP server using REPO_RESCUE_TRANSPORT.")
    return parser


def main(argv: list[str] | None = None) -> None:
    args = build_parser().parse_args(argv)
    if args.command == "serve":
        from .server import main as server_main

        server_main()
        return
    try:
        if args.command == "inspect":
            with clone_public_repository(args.repo_url) as snapshot:
                inspection = analyze_snapshot(snapshot)
            _print_inspection(inspection, as_json=args.as_json)
            raise SystemExit(0)
        if args.command == "demo":
            report = run_builtin_demo(artifacts_root=args.artifacts)
        else:
            report = run_github_repair(
                args.repo_url,
                issue=args.issue,
                artifacts_root=args.artifacts,
                max_attempts=args.max_attempts,
                model=args.model,
            )
    except Exception as exc:
        print(f"RepoRescue failed: {type(exc).__name__}: {exc}", file=sys.stderr)
        raise SystemExit(2) from exc
    _print_result(report, as_json=args.as_json)
    raise SystemExit(_report_exit_code(report))


if __name__ == "__main__":
    main()
