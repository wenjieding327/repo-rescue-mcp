from __future__ import annotations

import asyncio
import os
import subprocess
import sys
import time

from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client


async def exercise_server() -> None:
    async with streamable_http_client("http://127.0.0.1:8000/mcp") as (read, write, _):
        async with ClientSession(read, write) as session:
            await session.initialize()
            tools = await session.list_tools()
            print("TOOLS=" + ",".join(tool.name for tool in tools.tools))
            result = await session.call_tool(
                "inspect_github_project",
                {"repo_url": "https://github.com/pallets/click"},
            )
            print(f"CALL_ERROR={result.isError}")
            print("CONTENT_TYPES=" + ",".join(item.type for item in result.content))


def main() -> None:
    env = os.environ.copy()
    env["REPO_RESCUE_ALLOWED_REPOS"] = "pallets/click"
    process = subprocess.Popen(
        [sys.executable, "-m", "repo_rescue.server"],
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        time.sleep(2)
        asyncio.run(exercise_server())
    finally:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()


if __name__ == "__main__":
    main()
