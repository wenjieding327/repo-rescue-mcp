"""Verify a deployed four-tool gateway without logging credentials or request URLs."""
from __future__ import annotations

import asyncio
import json
import os
import sys

from mcp import ClientSession
from mcp.client.sse import sse_client


async def main() -> None:
    token = os.environ.get("REPO_RESCUE_HTTP_ACCESS_TOKEN", "")
    if not token:
        raise RuntimeError("Gateway access credential is missing.")
    async with sse_client(
        sys.argv[1], headers={"Authorization": f"Bearer {token}"},
        timeout=30, sse_read_timeout=60,
    ) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            names = sorted(tool.name for tool in (await session.list_tools()).tools)
            assert names == sorted([
                "rescue_python_snippet", "start_prepare_github_repair",
                "get_repair_job", "start_verify_github_patch",
            ])
            print(json.dumps({"handshake": True, "tools": names}), flush=True)
            cases = [
                ("snippet_repair", "print(1 / 0)", "print(0)", True),
                ("unsafe_import", "import os\nprint(os.getcwd())", "import os\nprint(os.getcwd())", False),
            ]
            for label, original, candidate, expected in cases:
                result = await session.call_tool("rescue_python_snippet", {
                    "original_code": original,
                    "candidate_code": candidate,
                    "test_cases": [{"name": "output", "expected_stdout": "0"}],
                })
                payload = json.loads(result.content[0].text)
                assert payload.get("fix_verified") is expected
                if not expected:
                    assert not payload.get("candidate_passed")
                print(json.dumps({"case": label, "status": payload["status"],
                                  "fix_verified": payload["fix_verified"],
                                  "test_results": payload["test_results"]}), flush=True)
            hidden = await session.call_tool("windows_environment_probe", {})
            assert hidden.isError
            print(json.dumps({"hidden_tool_rejected": True}), flush=True)
            # A complete keepalive interval proves the stream survives initial discovery.
            await asyncio.sleep(16)
            await session.send_ping()
            print(json.dumps({"sustained_sse_ping": True}), flush=True)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except BaseException as error:
        # SDK exceptions can embed URL/headers. Log only the exception type.
        print(json.dumps({"ok": False, "error_type": type(error).__name__}), flush=True)
        sys.exit(1)
