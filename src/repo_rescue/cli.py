from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any

from .orchestrator import run_builtin_demo, run_github_repair


def _print_result(report: dict[str, Any], *, as_json: bool) -> None:
    if as_json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return
    baseline = report.get("baseline", {}).get("execution", {})
    final = report.get("final_verification", {}).get("execution", {})
    print("RepoRescue automatic repair loop")
    print(f"result: {report.get('status')}")
    print(f"repository: {report.get('repository', {}).get('slug')}")
    print(f"commit: {report.get('repository', {}).get('commit')}")
    print(f"command: {report.get('baseline', {}).get('command')}")
    print(f"before: exit {baseline.get('exit_code')}")
    print(f"after:  exit {final.get('exit_code')}")
    print(f"changed: {', '.join(report.get('changed_files', [])) or 'none'}")
    print(f"patch: {report.get('artifacts', {}).get('patch')}")
    print(f"report: {report.get('artifacts', {}).get('report')}")
    print(f"evidence: {report.get('artifacts', {}).get('evidence')}")


def _artifacts_path(value: str) -> Path:
    return Path(value).expanduser().resolve()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="repo-rescue",
        description="Reproduce, repair, verify, and produce patch evidence for Python repositories.",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    demo = subparsers.add_parser("demo", help="Run the deterministic, no-API-key interview demo.")
    demo.add_argument("--artifacts", default="artifacts", type=_artifacts_path)
    demo.add_argument("--json", action="store_true", dest="as_json")

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
    raise SystemExit(0 if report.get("verified_repair") else 1)


if __name__ == "__main__":
    main()
