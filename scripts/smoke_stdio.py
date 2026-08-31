from __future__ import annotations

import json
import os
import queue
import subprocess
import sys
import threading
import time


def _read_json_response(
    responses: queue.Queue[dict[str, object] | BaseException],
    *,
    expected_id: int,
    deadline: float,
) -> dict[str, object]:
    """Wait for one JSON-RPC response without assuming batched pipe timing."""

    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError(f"Timed out waiting for JSON-RPC response id={expected_id}.")
        item = responses.get(timeout=remaining)
        if isinstance(item, BaseException):
            raise RuntimeError("RepoRescue stdio reader failed.") from item
        if item.get("id") == expected_id:
            return item


def _send_message(process: subprocess.Popen[str], message: dict[str, object]) -> None:
    if process.stdin is None:
        raise RuntimeError("RepoRescue stdio stdin was not created.")
    process.stdin.write(json.dumps(message) + "\n")
    process.stdin.flush()


def main() -> None:
    environment = os.environ.copy()
    environment["REPO_RESCUE_TRANSPORT"] = "stdio"
    process = subprocess.Popen(
        [sys.executable, "-m", "repo_rescue.server"],
        env=environment,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    responses: queue.Queue[dict[str, object] | BaseException] = queue.Queue()
    stderr_lines: list[str] = []

    def read_stdout() -> None:
        try:
            if process.stdout is None:
                raise RuntimeError("RepoRescue stdio stdout was not created.")
            for line in process.stdout:
                if line.strip():
                    responses.put(json.loads(line))
        except BaseException as exc:  # pragma: no cover - diagnostic path
            responses.put(exc)

    def read_stderr() -> None:
        if process.stderr is not None:
            stderr_lines.extend(process.stderr)

    stdout_thread = threading.Thread(target=read_stdout, daemon=True)
    stderr_thread = threading.Thread(target=read_stderr, daemon=True)
    stdout_thread.start()
    stderr_thread.start()
    deadline = time.monotonic() + 15
    try:
        _send_message(
            process,
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2025-06-18",
                    "capabilities": {},
                    "clientInfo": {"name": "repo-rescue-smoke", "version": "1"},
                },
            },
        )
        initialization = _read_json_response(responses, expected_id=1, deadline=deadline)
        _send_message(process, {"jsonrpc": "2.0", "method": "notifications/initialized"})
        _send_message(process, {"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}})
        tools = _read_json_response(responses, expected_id=2, deadline=deadline)
    except BaseException as exc:
        diagnostic = "".join(stderr_lines)[-4_000:]
        if diagnostic:
            raise RuntimeError(f"RepoRescue stdio smoke failed. Server stderr:\n{diagnostic}") from exc
        raise
    finally:
        if process.stdin is not None:
            process.stdin.close()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:  # pragma: no cover - defensive cleanup
                process.kill()
                process.wait(timeout=5)
    if process.returncode != 0:
        diagnostic = "".join(stderr_lines)[-4_000:]
        raise RuntimeError(f"RepoRescue stdio server exited with {process.returncode}:\n{diagnostic}")
    listed_tools = tools["result"]["tools"]
    names = [tool["name"] for tool in listed_tools]
    expected_tools = {
        "inspect_github_project",
        "reproduce_python_project",
        "repair_github_project",
        "prepare_github_repair",
        "start_prepare_github_repair",
        "verify_github_patch",
        "start_verify_github_patch",
        "get_repair_job",
        "run_interview_demo",
        "get_repair_artifact",
        "windows_environment_probe",
    }
    if len(names) != 11 or set(names) != expected_tools:
        raise RuntimeError("RepoRescue stdio must expose exactly the documented 11-tool Python contract.")
    if initialization["result"]["serverInfo"].get("version") != "0.4.0":
        raise RuntimeError("MCP serverInfo did not expose the RepoRescue package version.")
    verify_tool = next(tool for tool in listed_tools if tool["name"] == "verify_github_patch")
    schema = verify_tool["inputSchema"]
    required = set(schema.get("required", []))
    if not {"repo_url", "expected_commit", "expected_baseline_sha256", "changes"}.issubset(required):
        raise RuntimeError("verify_github_patch is missing required preparation-binding inputs.")
    patch_change = schema.get("$defs", {}).get("PatchChange", {})
    if set(patch_change.get("required", [])) != {"path", "content"}:
        raise RuntimeError("verify_github_patch changes must require path and content.")
    async_verify = next(tool for tool in listed_tools if tool["name"] == "start_verify_github_patch")
    async_properties = async_verify["inputSchema"]["properties"]
    if async_properties["changes"].get("maxItems") != 8:
        raise RuntimeError("start_verify_github_patch must bound the queued change list.")
    if async_properties["analysis"].get("maxLength") != 4_000:
        raise RuntimeError("start_verify_github_patch must bound queued analysis text.")
    poll_tool = next(tool for tool in listed_tools if tool["name"] == "get_repair_job")
    poll_properties = poll_tool["inputSchema"]["properties"]
    if poll_properties["job_id"].get("minLength") != 43 or poll_properties["job_id"].get("maxLength") != 43:
        raise RuntimeError("get_repair_job must publish the unguessable job ID shape.")
    if poll_properties["wait_seconds"].get("minimum") != 0 or poll_properties["wait_seconds"].get("maximum") != 20:
        raise RuntimeError("get_repair_job must publish the long-poll wait bounds.")
    print("SERVER=" + initialization["result"]["serverInfo"]["name"])
    print("VERSION=" + initialization["result"]["serverInfo"]["version"])
    print("TOOLS=" + ",".join(names))
    print("VERIFY_SCHEMA=commit+baseline+path+content required")
    print("ASYNC_REPAIR_TOOLS=start+poll bounded")


if __name__ == "__main__":
    main()
