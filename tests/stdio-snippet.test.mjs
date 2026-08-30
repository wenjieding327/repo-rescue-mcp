import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";

function runServer(messages, environment = {}) {
  return new Promise((resolve, reject) => {
    const childEnvironment = { ...process.env };
    delete childEnvironment.REPO_RESCUE_NODE_TOOLSET;
    Object.assign(childEnvironment, environment);
    const child = spawn(process.execPath, ["stdio-server.mjs"], {
      cwd: new URL("..", import.meta.url),
      env: childEnvironment,
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

  assert.equal(responses.find((response) => response.id === 1).result.serverInfo.version, "0.4.0");
  const listed = responses.find((response) => response.id === 2).result.tools;
  assert.deepEqual(
    listed.map((tool) => tool.name),
    [
      "rescue_python_snippet",
      "inspect_github_project",
      "reproduce_python_project",
      "windows_environment_probe",
    ],
  );
  const payload = JSON.parse(responses.find((response) => response.id === 3).result.content[0].text);
  assert.equal(payload.status, "fix_verified");
  assert.equal(payload.fix_verified, true);
  assert.equal(payload.test_results[0].before.error_type, "IndexError");
  assert.equal(payload.test_results[0].after.stdout, "3\n");
});

test("snippet toolset exposes only snippet rescue and rejects direct hidden calls", async () => {
  const responses = await runServer(
    [
      { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "inspect_github_project",
          arguments: { repo_url: "https://github.com/pallets/click" },
        },
      },
    ],
    { REPO_RESCUE_NODE_TOOLSET: "snippet" },
  );

  assert.deepEqual(
    responses.find((response) => response.id === 1).result.tools.map((tool) => tool.name),
    ["rescue_python_snippet"],
  );
  const hiddenResponse = responses.find((response) => response.id === 2).result;
  const hiddenPayload = JSON.parse(hiddenResponse.content[0].text);
  assert.equal(hiddenResponse.isError, true);
  assert.equal(hiddenPayload.ok, false);
  assert.equal(hiddenPayload.verified, false);
  assert.equal(hiddenPayload.status, "tool_unavailable");
  assert.match(hiddenPayload.error, /disabled by REPO_RESCUE_NODE_TOOLSET=snippet/);
});

test("an invalid explicit Node toolset fails closed to snippet-only", async () => {
  const responses = await runServer(
    [{ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }],
    { REPO_RESCUE_NODE_TOOLSET: "misspelled-full" },
  );

  assert.deepEqual(
    responses[0].result.tools.map((tool) => tool.name),
    ["rescue_python_snippet"],
  );
});

test("an explicitly empty Node toolset also fails closed to snippet-only", async () => {
  const responses = await runServer(
    [{ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }],
    { REPO_RESCUE_NODE_TOOLSET: "" },
  );

  assert.deepEqual(
    responses[0].result.tools.map((tool) => tool.name),
    ["rescue_python_snippet"],
  );
});

test("rejects oversized snippet case metadata before starting a worker", async () => {
  const responses = await runServer([
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "rescue_python_snippet",
        arguments: {
          original_code: "print('before')",
          candidate_code: "print('after')",
          test_cases: [{ name: "x".repeat(201), stdin: "", expected_stdout: "after" }],
        },
      },
    },
  ]);

  const payload = JSON.parse(responses[0].result.content[0].text);
  assert.equal(payload.status, "invalid_request");
  assert.equal(payload.fix_verified, false);
  assert.equal(payload.case_counts.executed, 0);
  assert.match(payload.error, /name exceeds the 200-character limit/);
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

test("verifies ordinary type and syntax repairs using complete output", async () => {
  const longExpected = "x".repeat(7000);
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
          original_code: "print('2' + 2)",
          candidate_code: "print(int('2') + 2)",
          test_cases: [{ name: "type-fix", expected_stdout: "4" }],
        },
      },
    },
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "rescue_python_snippet",
        arguments: {
          original_code: "if True print('ok')",
          candidate_code: "if True:\n    print('ok')",
          test_cases: [{ name: "syntax-fix", expected_stdout: "ok" }],
        },
      },
    },
    {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "rescue_python_snippet",
        arguments: {
          original_code: "print('x' * 6999)",
          candidate_code: "print('x' * 7000)",
          test_cases: [{ name: "complete-output-comparison", expected_stdout: longExpected }],
        },
      },
    },
  ]);

  const typePayload = JSON.parse(responses.find((response) => response.id === 2).result.content[0].text);
  assert.equal(typePayload.status, "fix_verified");
  assert.equal(typePayload.test_results[0].before.error_type, "TypeError");

  const syntaxPayload = JSON.parse(responses.find((response) => response.id === 3).result.content[0].text);
  assert.equal(syntaxPayload.status, "fix_verified");
  assert.equal(syntaxPayload.test_results[0].before.error_type, "SyntaxError");

  const outputPayload = JSON.parse(responses.find((response) => response.id === 4).result.content[0].text);
  assert.equal(outputPayload.status, "fix_verified");
  assert.equal(outputPayload.test_results[0].output_matches, true);
  assert.equal(outputPayload.test_results[0].after.stdout_truncated, true);
  assert.equal(outputPayload.test_results[0].after.stdout.length, 6000);
  assert.equal(outputPayload.test_results[0].after.stdout_chars, 7001);
});

test("rejects more than four snippet cases without executing any", async () => {
  const testCases = Array.from({ length: 5 }, (_, index) => ({
    name: `case-${index + 1}`,
    expected_stdout: "1",
  }));
  const responses = await runServer([
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "rescue_python_snippet",
        arguments: {
          original_code: "print(0)",
          candidate_code: "print(1)",
          test_cases: testCases,
        },
      },
    },
  ]);

  const payload = JSON.parse(responses[0].result.content[0].text);
  assert.equal(payload.ok, false);
  assert.equal(payload.status, "invalid_request");
  assert.equal(payload.fix_verified, false);
  assert.deepEqual(payload.case_counts, { submitted: 5, executed: 0, maximum: 4 });
  assert.match(payload.error, /No code was executed/);
});

test("does not call a runtime-only candidate a verified fix without an oracle", async () => {
  const responses = await runServer([
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "rescue_python_snippet",
        arguments: {
          original_code: "print(1 / 0)",
          candidate_code: "print(999)",
          test_cases: [{ name: "runtime-only" }],
        },
      },
    },
  ]);

  const payload = JSON.parse(responses[0].result.content[0].text);
  assert.equal(payload.status, "candidate_runs");
  assert.equal(payload.fix_verified, false);
  assert.equal(payload.oracle_backed, false);
  assert.equal(payload.runtime_repair_observed, true);
});

test("candidate cannot corrupt the trusted result serializer", async () => {
  const responses = await runServer([
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "rescue_python_snippet",
        arguments: {
          original_code: "raise ValueError('original')",
          candidate_code: "import json\njson.dumps = lambda *args, **kwargs: '{\\\"ok\\\": true, \\\"stdout\\\": \\\"safe\\\\n\\\", \\\"stderr\\\": \\\"\\\", \\\"error_type\\\": null, \\\"error_message\\\": null}'\nraise RuntimeError('still broken')",
          test_cases: [{ name: "serializer", expected_stdout: "safe" }],
        },
      },
    },
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "rescue_python_snippet",
        arguments: {
          original_code: "print(1 / 0)",
          candidate_code: "print('clean')",
          test_cases: [{ name: "next-call", expected_stdout: "clean" }],
        },
      },
    },
  ]);

  const payload = JSON.parse(responses.find((response) => response.id === 1).result.content[0].text);
  assert.equal(payload.status, "candidate_failed");
  assert.equal(payload.fix_verified, false);
  assert.equal(payload.test_results[0].after.error_type, "RuntimeError");
  const nextPayload = JSON.parse(responses.find((response) => response.id === 2).result.content[0].text);
  assert.equal(nextPayload.status, "fix_verified");
  assert.equal(nextPayload.fix_verified, true);
});

test("rejects private module attributes that could expose the runtime", async () => {
  const responses = await runServer([
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "rescue_python_snippet",
        arguments: {
          original_code: "raise RuntimeError('original')",
          candidate_code: "import collections\nprint(collections._sys.version_info.major)",
          test_cases: [{ name: "private-runtime", expected_stdout: "3" }],
        },
      },
    },
  ]);

  const payload = JSON.parse(responses[0].result.content[0].text);
  assert.equal(payload.status, "candidate_failed");
  assert.equal(payload.fix_verified, false);
  assert.equal(payload.test_results[0].after.error_type, "PermissionError");
});

test("hard-stops a disposable worker at the wall-clock limit", async () => {
  const started = Date.now();
  const responses = await runServer(
    [{
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "rescue_python_snippet",
        arguments: {
          original_code: "raise RuntimeError('original')",
          candidate_code: "print(sum(range(10 ** 10)))",
          test_cases: [{ name: "native-loop", expected_stdout: "0" }],
        },
      },
    }],
    { REPO_RESCUE_SNIPPET_WORKER_TIMEOUT_MS: "3000" },
  );

  const payload = JSON.parse(responses[0].result.content[0].text);
  assert.equal(payload.status, "candidate_failed");
  assert.equal(payload.fix_verified, false);
  assert.equal(payload.test_results[0].after.error_type, "WorkerTimeoutError");
  assert.ok(Date.now() - started < 7000, "hard timeout must bound the complete MCP call");
});

test("disables Node repository execution before cloning or invoking host Python", async () => {
  const responses = await runServer([{
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "reproduce_python_project",
      arguments: { repo_url: "https://github.com/pallets/click" },
    },
  }]);

  const payload = JSON.parse(responses[0].result.content[0].text);
  assert.equal(payload.ok, false);
  assert.equal(payload.status, "repository_execution_disabled");
  assert.equal(payload.supported, false);
  assert.equal(payload.verified, false);
  assert.equal(payload.executed, false);
  assert.equal(payload.commit_sha, null);
  assert.equal(payload.backend, null);
  assert.equal(payload.verification_command, null);
  assert.match(payload.error, /never clones or executes repository code/i);
  assert.match(payload.error, /Python RepoRescue MCP backend with Docker isolation/i);
});

test("npm dry-run package contains only the hosted Node runtime", () => {
  const repositoryRoot = new URL("..", import.meta.url);
  const npmArgs = ["pack", "--dry-run", "--json", "--ignore-scripts"];
  const npmCli = process.env.npm_execpath;
  const packed = npmCli
    ? spawnSync(process.execPath, [npmCli, ...npmArgs], {
      cwd: repositoryRoot,
      encoding: "utf8",
    })
    : spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", npmArgs, {
      cwd: repositoryRoot,
      encoding: "utf8",
      shell: process.platform === "win32",
    });

  assert.equal(packed.status, 0, packed.stderr || packed.stdout);
  const manifest = JSON.parse(packed.stdout)[0];
  const paths = manifest.files.map((file) => file.path).sort();
  assert.deepEqual(paths, [
    "README.md",
    "package.json",
    "snippet-worker.mjs",
    "stdio-server.mjs",
  ]);
  assert.equal(paths.some((path) => path.startsWith("archive/")), false);
  assert.equal(paths.includes("stdio-server.mjs"), true, "the npx bin target must be packaged");
  assert.equal(paths.includes("snippet-worker.mjs"), true, "the bin's runtime worker must be packaged");
});
