from __future__ import annotations

import json
import os
import subprocess
import sys


def main() -> None:
    environment = os.environ.copy()
    environment["REPO_RESCUE_TRANSPORT"] = "stdio"
    messages = [
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
        {"jsonrpc": "2.0", "method": "notifications/initialized"},
        {"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}},
    ]
    result = subprocess.run(
        [sys.executable, "-m", "repo_rescue.server"],
        env=environment,
        input="\n".join(json.dumps(message) for message in messages) + "\n",
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=15,
        check=True,
    )
    responses = [json.loads(line) for line in result.stdout.splitlines() if line.strip()]
    initialization = next(response for response in responses if response.get("id") == 1)
    tools = next(response for response in responses if response.get("id") == 2)
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
