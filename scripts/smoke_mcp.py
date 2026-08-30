from __future__ import annotations

import asyncio
import json
import os
import socket
import subprocess
import sys
import time
from pathlib import Path

from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client


async def exercise_server(port: int) -> None:
    async with streamable_http_client(f"http://127.0.0.1:{port}/mcp") as (read, write, _):
        async with ClientSession(read, write) as session:
            await session.initialize()
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
                raise RuntimeError("HTTP transport did not expose exactly the documented 11-tool contract.")
            print("TOOLS=" + ",".join(tool.name for tool in tools.tools))
            result = await session.call_tool(
                "inspect_github_project",
                {"repo_url": "https://example.com/not-a-github-repository"},
            )
            if result.isError:
                raise RuntimeError("MCP inspection error escaped the controlled response contract.")
            inspection_payload = json.loads(result.content[0].text)
            if inspection_payload.get("ok") is not False or inspection_payload.get("error_type") != "SecurityError":
                raise RuntimeError("MCP inspection did not return the expected controlled validation response.")
            print(f"CALL_ERROR={result.isError}")
            print("INSPECT_CONTROLLED=True")
            print("CONTENT_TYPES=" + ",".join(item.type for item in result.content))
            demo = await session.call_tool("run_interview_demo", {})
            demo_text = demo.content[0].text
            payload = json.loads(demo_text)
            if (
                demo.isError
                or payload.get("ok") is not True
                or payload.get("repair", {}).get("status") != "verified_repair"
                or payload.get("repair", {}).get("verified_repair") is not True
            ):
                raise RuntimeError("MCP interview Demo did not produce a verified repair.")
            print(f"DEMO_STATUS={payload['repair']['status']}")
            print(f"DEMO_RUN_ID={payload['repair']['run_id']}")
            print(f"ARTIFACT_ACCESS={payload['repair']['artifacts']['retrieval_tool']}")
            if set(payload["repair"]["artifacts"]) != {"run_id", "available", "retrieval_tool"}:
                raise RuntimeError("MCP repair response exposed a server-local artifact path.")
            artifact = await session.call_tool(
                "get_repair_artifact",
                {"run_id": payload["repair"]["run_id"], "artifact": "patch"},
            )
            artifact_payload = json.loads(artifact.content[0].text)["artifact"]
            if artifact.isError or artifact_payload.get("complete") is not True:
                raise RuntimeError("MCP patch artifact was not returned completely.")
            if "--- a/" not in artifact_payload["content"] or "+++ b/" not in artifact_payload["content"]:
                raise RuntimeError("MCP patch artifact did not contain a unified diff.")
            print(f"ARTIFACT_COMPLETE={artifact_payload['complete']}")
            print(f"ARTIFACT_HAS_DIFF={'return a / b' in artifact_payload['content']}")
            evidence = await session.call_tool(
                "get_repair_artifact",
                {"run_id": payload["repair"]["run_id"], "artifact": "evidence"},
            )
            evidence_content = json.loads(evidence.content[0].text)["artifact"]["content"]
            evidence_payload = json.loads(evidence_content)
            if evidence.isError or evidence_payload.get("verified_repair") is not True:
                raise RuntimeError("MCP evidence artifact did not preserve the verified repair verdict.")
            if str(Path.cwd()) in demo_text or "repo-rescue-local-" in demo_text or "file:///" in demo_text:
                raise RuntimeError("MCP demo response exposed a local repository or temporary path.")
            if str(Path.cwd()) in evidence_content or "repo-rescue-local-" in evidence_content or "file:///" in evidence_content:
                raise RuntimeError("MCP evidence artifact exposed a local repository or temporary path.")


def main() -> None:
    with socket.socket() as reserved:
        reserved.bind(("127.0.0.1", 0))
        port = int(reserved.getsockname()[1])
    env = os.environ.copy()
    env["REPO_RESCUE_ALLOWED_REPOS"] = "pallets/click"
    env["REPO_RESCUE_PORT"] = str(port)
    process = subprocess.Popen(
        [sys.executable, "-m", "repo_rescue.server"],
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    try:
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            if process.poll() is not None:
                error = process.stderr.read() if process.stderr else ""
                raise RuntimeError(f"MCP server exited during startup: {error[-2000:]}")
            try:
                with socket.create_connection(("127.0.0.1", port), timeout=0.25):
                    break
            except OSError:
                time.sleep(0.1)
        else:
            raise RuntimeError("MCP server did not become ready within 15 seconds.")
        asyncio.run(exercise_server(port))
    finally:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()


if __name__ == "__main__":
    main()
