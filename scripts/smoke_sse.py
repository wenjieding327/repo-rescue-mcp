from __future__ import annotations

import asyncio
import os
import socket
import subprocess
import sys
import time

from mcp import ClientSession
from mcp.client.sse import sse_client


async def exercise_server(port: int) -> None:
    async with sse_client(f"http://127.0.0.1:{port}/sse", timeout=5) as (read, write):
        async with ClientSession(read, write) as session:
            initialized = await session.initialize()
            tools = await session.list_tools()
            names = {tool.name for tool in tools.tools}
            expected = {
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
            if len(names) != 11 or names != expected:
                raise RuntimeError("SSE transport did not expose exactly the documented 11-tool contract.")
            if initialized.serverInfo.version != "0.4.1":
                raise RuntimeError("SSE serverInfo did not expose the RepoRescue package version.")
            print(f"SERVER={initialized.serverInfo.name}")
            print(f"VERSION={initialized.serverInfo.version}")
            print(f"SSE_TOOLS={len(names)}")
            print("SSE_HANDSHAKE=True")


def main() -> None:
    with socket.socket() as reserved:
        reserved.bind(("127.0.0.1", 0))
        port = int(reserved.getsockname()[1])
    environment = os.environ.copy()
    environment["REPO_RESCUE_TRANSPORT"] = "sse"
    environment["REPO_RESCUE_PORT"] = str(port)
    environment.pop("REPO_RESCUE_SSE_MOUNT_PATH", None)
    process = subprocess.Popen(
        [sys.executable, "-m", "repo_rescue.server"],
        env=environment,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            if process.poll() is not None:
                raise RuntimeError("SSE MCP server exited during startup.")
            try:
                with socket.create_connection(("127.0.0.1", port), timeout=0.25):
                    break
            except OSError:
                time.sleep(0.1)
        else:
            raise RuntimeError("SSE MCP server did not become ready within 15 seconds.")
        asyncio.run(exercise_server(port))
    finally:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()


if __name__ == "__main__":
    main()
