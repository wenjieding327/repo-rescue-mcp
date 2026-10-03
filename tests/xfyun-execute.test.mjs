import assert from "node:assert/strict";
import test from "node:test";
import { request as httpRequest } from "node:http";
import { createLegacySseServer, parseXfyunExecutionRequest } from "../http-sse-server.mjs";

const ACCESS_TOKEN = "test-only-xfyun-execute-access-token-at-least-32-bytes";
const STAMP = "2026-10-03T08:00:00.000Z";
const SNIPPET = { route: "snippet", original_code: "print(1 / 0)", candidate_code: "print(3)", test_cases: [{ name: "complete", expected_stdout: "3" }] };
const JOB = { route: "github", repo_url: "https://github.com/pallets/click", job_id: "A".repeat(43), request_started_at: STAMP };
const raw = (request) => JSON.stringify({ request_json: JSON.stringify(request) });

// Failure diagnostics deliberately exclude source, streams, messages and credentials.
function snippetDiagnostic(payload) {
  const errors = new Set(["WorkerTimeoutError", "WorkerProtocolError", "WorkerLaunchError", "ZeroDivisionError", "IndexError", "PermissionError"]);
  return JSON.stringify({
    status: ["fix_verified", "candidate_runs", "candidate_failed"].includes(payload.status) ? payload.status : "unknown",
    worker_timeout_ms: Number.isSafeInteger(payload.worker_timeout_ms) ? payload.worker_timeout_ms : null,
    error_type: (Array.isArray(payload.test_results) ? payload.test_results : []).flatMap((item) => ["before", "after"].map((phase) => errors.has(item?.[phase]?.error_type) ? item[phase].error_type : item?.[phase]?.error_type ? "other" : null)),
  });
}

async function startServer(t, configured = {}) {
  const environment = { REPO_RESCUE_GITHUB_TOKEN: "", REPO_RESCUE_HTTP_ACCESS_TOKEN: ACCESS_TOKEN };
  for (const key of ["PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE"]) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  Object.assign(environment, configured);
  const service = createLegacySseServer({ environment, host: "127.0.0.1", port: 0 });
  const address = await service.listen();
  t.after(() => service.close());
  return `http://127.0.0.1:${address.port}`;
}

function post(baseUrl, body, headers = {}, path = "/xfyun/execute") {
  return fetch(baseUrl + path, { method: "POST", headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, "Content-Type": "application/json", ...headers }, body });
}

async function business(response) {
  assert.equal(response.status, 200);
  const envelope = await response.json();
  assert.deepEqual(Object.keys(envelope).sort(), ["is_error", "receipt_url", "result_json"]);
  const mcp = JSON.parse(envelope.result_json);
  assert.equal(mcp.receipt_url, envelope.receipt_url);
  return { envelope, mcp, payload: JSON.parse(mcp.content[0].text) };
}

test("strict route translator only creates reviewed snippet calls and 15-second polls", () => {
  assert.deepEqual(parseXfyunExecutionRequest(raw(SNIPPET)), { route: "snippet", toolName: "rescue_python_snippet", arguments: { original_code: SNIPPET.original_code, candidate_code: SNIPPET.candidate_code, test_cases: SNIPPET.test_cases } });
  assert.deepEqual(parseXfyunExecutionRequest(raw(JOB)), { route: "github", toolName: "get_repair_job", arguments: { job_id: JOB.job_id, wait_seconds: 15 } });
  assert.deepEqual(parseXfyunExecutionRequest(raw({ route: "advice" })), { route: "advice", toolName: null, arguments: null });
});

test("execute requires the same bearer header, Origin guard and application/json", async (t) => {
  const url = await startServer(t);
  for (const headers of [{ Authorization: "" }, { Authorization: "Bearer wrong" }, { Authorization: `Bearer ${ACCESS_TOKEN} extra` }]) assert.equal((await post(url, raw({ route: "advice" }), headers)).status, 401);
  assert.equal((await post(url, raw({ route: "advice" }), { Authorization: "" }, `/xfyun/execute?token=${ACCESS_TOKEN}`)).status, 401);
  assert.equal((await post(url, raw({ route: "advice" }), { Origin: "https://example.com" })).status, 403);
  assert.equal((await post(url, raw({ route: "advice" }), { "Content-Type": "text/plain" })).status, 415);
  assert.equal((await fetch(url + "/xfyun/execute")).status, 404);
});

test("advice is a fixed unexecuted result, never model output or a worker tool", async (t) => {
  const url = await startServer(t);
  const { payload, envelope } = await business(await post(url, raw({ route: "advice" })));
  assert.deepEqual(payload, { ok: true, mode: "xfyun_safe_advice", status: "advice_only", executed: false, fix_verified: false, verified_repair: false, test_results: [], user_summary: "未执行任何代码或仓库任务；当前仅为未验证建议。" });
  assert.equal(envelope.is_error, false);
  assert.equal(envelope.receipt_url, "");
  for (const key of ["advice", "report", "modelreport", "candidate_code", "verified", "receipt_url"]) assert.equal((await post(url, raw({ route: "advice", [key]: "UNTRUSTED-SENTINEL" }))).status, 400);
});

test("real snippet execution reaches the existing protected worker and preserves literal evidence", { timeout: 60000 }, async (t) => {
  const url = await startServer(t);
  const { payload, envelope } = await business(await post(url, raw(SNIPPET)));
  assert.equal(envelope.is_error, false);
  assert.equal(payload.status, "fix_verified", snippetDiagnostic(payload));
  assert.equal(payload.fix_verified, true);
  assert.equal(payload.execution_backend, "pyodide_disposable_child_process");
  assert.equal(payload.test_results[0].before.stdout, "");
  assert.equal(payload.test_results[0].before.error_type, "ZeroDivisionError");
  assert.equal(payload.test_results[0].after.stdout, "3\n");
  const { payload: failed } = await business(await post(url, raw({ ...SNIPPET, candidate_code: "import os\nprint(3)" })));
  assert.equal(failed.status, "candidate_failed");
  assert.equal(failed.fix_verified, false);
  assert.equal(failed.test_results[0].after.error_type, "PermissionError");
});

test("github only polls an existing capability and cannot dispatch a job", async (t) => {
  const url = await startServer(t, { REPO_RESCUE_GITHUB_TOKEN: "mock-only-local-unknown-job-no-network" });
  const { payload, envelope } = await business(await post(url, raw(JOB)));
  assert.equal(payload.ok, false);
  assert.equal(payload.status, "unknown_job");
  assert.equal(payload.job, undefined);
  assert.equal(envelope.receipt_url, "");
  for (const field of ["wait_seconds", "toolName", "name", "method", "params", "changes", "preparation_job_id", "expected_commit", "receipt_url"]) assert.equal((await post(url, raw({ ...JOB, [field]: field === "wait_seconds" ? 999 : "hidden" }))).status, 400);
});

test("malformed outer and inner JSON, unknown routes and hidden protocol fields are rejected without echo", async (t) => {
  const url = await startServer(t);
  for (const body of ["", "invalid-SENTINEL", "[]", "null", "{}", '{"request_json":{}}', '{"request_json":"[]"}', '{"request_json":"null"}', JSON.stringify({ request_json: "```json\n{}\n```" }), JSON.stringify({ request_json: "{}{}" }), JSON.stringify({ request_json: JSON.stringify({ route: "start_verify_github_patch" }) }), JSON.stringify({ request_json: JSON.stringify({ route: "ADVICE" }) }), JSON.stringify({ request_json: '{"route":"advice"}', toolName: "start_prepare_github_repair" })]) {
    const response = await post(url, body);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, "invalid_execution_request");
  }
});

test("duplicate decoded keys are rejected at both envelopes and inside frozen cases", async (t) => {
  const url = await startServer(t);
  const advice = JSON.stringify('{"route":"advice"}');
  const innerDuplicates = [
    '{"route":"advice","route":"snippet"}',
    '{"route":"advice","\\u0072oute":"advice"}',
    '{"route":"snippet","original_code":"print(0)","candidate_code":"print(1)","test_cases":[{"expected_stdout":"0","expected_stdout":"1"}]}',
  ];
  const bodies = [`{"request_json":${advice},"request_json":${advice}}`, `{"request_json":${advice},"\\u0072equest_json":${advice}}`, ...innerDuplicates.map((request_json) => JSON.stringify({ request_json }))];
  for (const body of bodies) assert.equal((await post(url, body)).status, 400);
  // Key-looking fragments inside ordinary code strings are not duplicate keys.
  const request = { ...SNIPPET, candidate_code: 'print("route route \\\"route\\\": false")' };
  assert.equal(parseXfyunExecutionRequest(raw(request)).arguments.candidate_code, request.candidate_code);
});

test("strict code/case/job/url/time sizes and types fail closed", () => {
  for (const request of [
    { ...SNIPPET, original_code: " " }, { ...SNIPPET, candidate_code: 1 }, { ...SNIPPET, candidate_code: "x".repeat(12001) }, { ...SNIPPET, candidate_code: "\ud800" },
    { ...SNIPPET, test_cases: "[]" }, { ...SNIPPET, test_cases: [null] }, { ...SNIPPET, test_cases: [{ expected_stdout: null }] }, { ...SNIPPET, test_cases: [{ stdin: false }] }, { ...SNIPPET, test_cases: [{ name: "x".repeat(201) }] }, { ...SNIPPET, test_cases: [{ method: "tools/list" }] }, { ...SNIPPET, test_cases: [{ constructor: "hidden" }] }, { ...SNIPPET, test_cases: Array.from({ length: 5 }, () => ({})) },
    { ...JOB, job_id: "A".repeat(42) }, { ...JOB, job_id: "A".repeat(44) }, { ...JOB, job_id: "A".repeat(42) + "=" }, { ...JOB, job_id: "A".repeat(42) + "中" }, { ...JOB, job_id: "A".repeat(42) + "\n" },
    { ...JOB, repo_url: "https://github.com@evil.example/a/b" }, { ...JOB, repo_url: JOB.repo_url + "?x=1" }, { ...JOB, request_started_at: "2026-02-30T00:00:00Z" }, { ...JOB, request_started_at: "2026-10-03" }, { ...JOB, request_started_at: 1 },
  ]) assert.throws(() => parseXfyunExecutionRequest(raw(request)));
  assert.throws(() => parseXfyunExecutionRequest(JSON.stringify({ request_json: " ".repeat(80001) })));
  assert.throws(() => parseXfyunExecutionRequest(JSON.stringify({ request_json: "[".repeat(100) + "0" + "]".repeat(100) })));
});

test("execute uploads inherit 1 MiB rejection and leave the server usable", async (t) => {
  const url = await startServer(t);
  const status = await new Promise((resolve, reject) => {
    const upload = httpRequest(url + "/xfyun/execute", { method: "POST", headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, "Content-Type": "application/json" } }, (response) => {
      response.resume(); response.on("end", () => resolve(response.statusCode));
    });
    upload.on("error", reject);
    for (let index = 0; index < 32; index += 1) upload.write(Buffer.alloc(65536, 120));
    upload.end();
  });
  assert.equal(status, 413);
  assert.equal((await fetch(url + "/healthz")).status, 200);
  assert.equal((await post(url, raw({ route: "advice" }))).status, 200);
});

test("advice cannot bypass the existing 120-per-minute global rate limit", async (t) => {
  const url = await startServer(t);
  for (let index = 0; index < 120; index += 1) {
    const response = await post(url, raw({ route: "advice" }));
    assert.equal(response.status, 200);
    await response.arrayBuffer();
  }
  const blocked = await post(url, raw({ route: "advice" }));
  assert.equal(blocked.status, 429);
  assert.equal((await blocked.json()).error, "request_rate_limited");
});

test("four real pending snippets block both advice and another execution", { timeout: 60000 }, async (t) => {
  const url = await startServer(t);
  const args = { ...SNIPPET, original_code: "print(0)", candidate_code: "print(1)", test_cases: [{ expected_stdout: "1" }] };
  const active = Array.from({ length: 4 }, () => post(url, raw(args)));
  let admission;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    const response = await post(url, raw({ route: "advice" }));
    admission = response.status;
    await response.arrayBuffer();
    if (admission === 429) break;
  }
  assert.equal(admission, 429);
  assert.equal((await post(url, raw(args))).status, 429);
  for (const response of await Promise.all(active)) {
    const { payload } = await business(response);
    assert.equal(payload.fix_verified, true, snippetDiagnostic(payload));
  }
});
