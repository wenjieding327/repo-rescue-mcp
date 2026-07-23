import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

function runServer(messages) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["stdio-server.mjs"], {
      cwd: new URL("..", import.meta.url),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`server exited ${code}: ${stderr}`));
        return;
      }
      resolve(stdout.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)));
    });
    child.stdin.end(messages.map((message) => JSON.stringify(message)).join("\n") + "\n");
  });
}

test("lists and executes verified snippet rescue", async () => {
  const responses = await runServer([
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
    },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "rescue_python_snippet",
        arguments: {
          original_code: "numbers = [1, 2, 3]\nprint(numbers[3])",
          candidate_code: "numbers = [1, 2, 3]\nprint(numbers[-1])",
          test_cases: [{ name: "last-item", stdin: "", expected_stdout: "3" }],
        },
      },
    },
  ]);

  const listed = responses.find((response) => response.id === 2).result.tools;
  assert.ok(listed.some((tool) => tool.name === "rescue_python_snippet"));
  const payload = JSON.parse(responses.find((response) => response.id === 3).result.content[0].text);
  assert.equal(payload.status, "fix_verified");
  assert.equal(payload.fix_verified, true);
  assert.equal(payload.test_results[0].before.error_type, "IndexError");
  assert.equal(payload.test_results[0].after.stdout, "3\n");
});

test("rejects unsafe snippet capabilities", async () => {
  const responses = await runServer([
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
    },
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "rescue_python_snippet",
        arguments: {
          original_code: "print('safe')",
          candidate_code: "import os\nprint(os.getcwd())",
        },
      },
    },
  ]);

  const payload = JSON.parse(responses.find((response) => response.id === 2).result.content[0].text);
  assert.equal(payload.status, "candidate_failed");
  assert.equal(payload.test_results[0].after.error_type, "PermissionError");
});

test("stops runaway student code with an execution budget", async () => {
  const responses = await runServer([
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
    },
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "rescue_python_snippet",
        arguments: {
          original_code: "while True:\n    pass",
          candidate_code: "print('stopped')",
          test_cases: [{ name: "loop-fix", expected_stdout: "stopped" }],
        },
      },
    },
  ]);

  const payload = JSON.parse(responses.find((response) => response.id === 2).result.content[0].text);
  assert.equal(payload.status, "fix_verified");
  assert.equal(payload.test_results[0].before.error_type, "TimeoutError");
});
