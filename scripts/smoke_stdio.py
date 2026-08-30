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
    verify_tool = next(tool for tool in listed_tools if tool["name"] == "verify_github_patch")
    schema = verify_tool["inputSchema"]
    required = set(schema.get("required", []))
    if not {"repo_url", "expected_commit", "expected_baseline_sha256", "changes"}.issubset(required):
        raise RuntimeError("verify_github_patch is missing required preparation-binding inputs.")
    patch_change = schema.get("$defs", {}).get("PatchChange", {})
    if set(patch_change.get("required", [])) != {"path", "content"}:
        raise RuntimeError("verify_github_patch changes must require path and content.")
    print("SERVER=" + initialization["result"]["serverInfo"]["name"])
    print("TOOLS=" + ",".join(names))
    print("VERIFY_SCHEMA=commit+baseline+path+content required")


if __name__ == "__main__":
    main()
