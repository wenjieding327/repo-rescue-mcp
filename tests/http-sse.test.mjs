import assert from "node:assert/strict";
import test from "node:test";
import { request as httpRequest } from "node:http";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createLegacySseServer, httpToolEnvelope } from "../http-sse-server.mjs";

const ACCESS_TOKEN = "test-only-access-token-with-at-least-32-bytes";

test("HTTP delivery mints only terminal verify receipts and preserves the complete original MCP result", () => {
  const result = { ok: true, repair: { verified_repair: true }, github_actions: {} };
  const value = { ok: true, job: { terminal: true, status: "succeeded", operation: "verify_github_patch", result } };
  const makeMessage = (payload) => ({ result: { content: [{ type: "text", text: JSON.stringify(payload) }], isError: false } });
  const message = makeMessage(value);
  let calls = 0;
  const receipts = { mint: (actual) => { calls++; assert.deepEqual(actual, result); return "https://receipts.example/r/signed"; } };
  const envelope = httpToolEnvelope(message, "get_repair_job", receipts);
  assert.equal(envelope.receipt_url, "https://receipts.example/r/signed");
  const compatibleResult = JSON.parse(envelope.result_json);
  assert.equal(compatibleResult.receipt_url, envelope.receipt_url);
  const { receipt_url, ...preservedResult } = compatibleResult;
  assert.equal(receipt_url, "https://receipts.example/r/signed");
  assert.deepEqual(preservedResult, message.result);
  assert.equal(preservedResult.content[0].text, message.result.content[0].text);
  // Simulate the existing XFYun schema projecting away the undeclared outer
  // receipt_url field: the declared result_json still carries the exact link.
  const oldSchemaProjection = { is_error: envelope.is_error, result_json: envelope.result_json };
  assert.equal(JSON.parse(oldSchemaProjection.result_json).receipt_url, "https://receipts.example/r/signed");
  assert.equal(envelope.is_error, false);
  for (const operation of ["rescue_python_snippet", "start_verify_github_patch", "start_prepare_github_repair"]) {
    const rejected = httpToolEnvelope(message, operation, receipts);
    assert.equal(rejected.receipt_url, "");
    assert.equal(JSON.parse(rejected.result_json).receipt_url, "");
  }
  for (const job of [
    { ...value.job, terminal: false }, { ...value.job, status: "failed" },
    { ...value.job, operation: "prepare_github_repair" },
  ]) {
    const rejected = httpToolEnvelope(makeMessage({ ...value, job }), "get_repair_job", receipts);
    assert.equal(rejected.receipt_url, "");
    assert.equal(JSON.parse(rejected.result_json).receipt_url, "");
  }
  for (const rejected of [
    httpToolEnvelope(makeMessage({ ...value, ok: false }), "get_repair_job", receipts),
    httpToolEnvelope({ ...message, error: { code: -1, message: "failed" } }, "get_repair_job", receipts),
    httpToolEnvelope({ result: { content: [{ type: "text", text: "invalid" }] } }, "get_repair_job", receipts),
  ]) {
    assert.equal(rejected.receipt_url, "");
    assert.equal(JSON.parse(rejected.result_json).receipt_url, "");
  }
  assert.equal(calls, 1);
  const unavailable = httpToolEnvelope(message, "get_repair_job", { mint() { throw new Error("unavailable"); } });
  assert.equal(unavailable.receipt_url, "");
  assert.equal(JSON.parse(unavailable.result_json).receipt_url, "");
  const { receipt_url: unavailableReceipt, ...unavailableResult } = JSON.parse(unavailable.result_json);
  assert.equal(unavailableReceipt, "");
  assert.deepEqual(unavailableResult, message.result);
});

test("HTTP delivery overwrites an upstream receipt field instead of trusting it", () => {
  const value = { ok: true, job: { terminal: false, status: "queued", operation: "verify_github_patch" } };
  const message = { result: {
    receipt_url: "https://attacker.invalid/r/spoof",
    content: [{ type: "text", text: JSON.stringify(value) }],
    isError: false,
  } };
  let called = false;
  const envelope = httpToolEnvelope(message, "get_repair_job", { mint() { called = true; return "https://attacker.invalid"; } });
  assert.equal(called, false);
  assert.equal(envelope.receipt_url, "");
  assert.equal(JSON.parse(envelope.result_json).receipt_url, "");
  assert.equal(JSON.parse(envelope.result_json).content[0].text, message.result.content[0].text);

  const verified = { ok: true, repair: { verified_repair: true } };
  const terminalMessage = { result: {
    receipt_url: "https://attacker.invalid/r/spoof",
    content: [{ type: "text", text: JSON.stringify({
      ok: true,
      job: { terminal: true, status: "succeeded", operation: "verify_github_patch", result: verified },
    }) }],
    isError: false,
  } };
  const safeEnvelope = httpToolEnvelope(terminalMessage, "get_repair_job", {
    mint(actual) {
      assert.deepEqual(actual, verified);
      return "https://receipts.example/r/safe";
    },
  });
  assert.equal(safeEnvelope.receipt_url, "https://receipts.example/r/safe");
  assert.equal(JSON.parse(safeEnvelope.result_json).receipt_url, safeEnvelope.receipt_url);
  assert.equal(JSON.parse(safeEnvelope.result_json).content[0].text, terminalMessage.result.content[0].text);
});

async function postTool(baseUrl, name, args, headers = {}) {
  return fetch(`${baseUrl}/api/tools/${name}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, "Content-Type": "application/json", ...headers },
    body: JSON.stringify(args),
  });
}

async function httpToolPayload(response, expectedIsError = false) {
  assert.equal(response.status, 200);
  const envelope = await response.json();
  assert.equal(envelope.is_error, expectedIsError);
  const mcpResult = JSON.parse(envelope.result_json);
  return JSON.parse(mcpResult.content[0].text);
}

async function startServer(t, environment = {}) {
  const service = createLegacySseServer({
    environment: {
      ...process.env,
      REPO_RESCUE_GITHUB_TOKEN: "",
      ...environment,
    },
    host: "127.0.0.1",
    port: 0,
    accessToken: ACCESS_TOKEN,
  });
  const address = await service.listen();
  t.after(() => service.close());
  return { service, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function openSession(baseUrl, token = ACCESS_TOKEN) {
  const controller = new AbortController();
  const response = await fetch(`${baseUrl}/sse`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: controller.signal,
  });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  async function nextEvent() {
    while (!buffered.includes("\n\n")) {
      const { done, value } = await reader.read();
      if (done) throw new Error("SSE stream ended before the next event.");
      buffered += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
    }
    const boundary = buffered.indexOf("\n\n");
    const raw = buffered.slice(0, boundary);
    buffered = buffered.slice(boundary + 2);
    const fields = Object.fromEntries(raw.split("\n").filter((line) => !line.startsWith(":" )).map((line) => {
      const separator = line.indexOf(":");
      return [line.slice(0, separator), line.slice(separator + 1).trimStart()];
    }));
    return {
      event: fields.event,
      data: fields.data === undefined
        ? undefined
        : fields.event === "endpoint"
          ? fields.data
          : JSON.parse(fields.data),
    };
  }
  return { response, controller, nextEvent };
}

async function postRpc(baseUrl, endpoint, message, token = ACCESS_TOKEN) {
  return fetch(new URL(endpoint, baseUrl), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(message),
  });
}

test("health is public but the MCP transport requires a bearer token", async (t) => {
  const { baseUrl } = await startServer(t);
  const health = await fetch(`${baseUrl}/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true, service: "repo-rescue-mcp", transport: "legacy-sse" });
  const unauthorized = await fetch(`${baseUrl}/sse`);
  assert.equal(unauthorized.status, 401);
  assert.equal((await unauthorized.json()).error, "unauthorized");
});

test("legacy SSE announces its POST endpoint and preserves caller JSON-RPC ids", async (t) => {
  const { baseUrl } = await startServer(t);
  const session = await openSession(baseUrl);
  t.after(() => session.controller.abort());
  assert.equal(session.response.status, 200);
  assert.match(session.response.headers.get("content-type"), /^text\/event-stream/);
  const endpoint = await session.nextEvent();
  assert.equal(endpoint.event, "endpoint");
  assert.match(endpoint.data, /^\/messages\/\?session_id=[A-Za-z0-9_-]{43}$/);

  const accepted = await postRpc(baseUrl, endpoint.data, {
    jsonrpc: "2.0",
    id: "caller-visible-id",
    method: "initialize",
    params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } },
  });
  assert.equal(accepted.status, 202);
  const reply = await session.nextEvent();
  assert.equal(reply.event, "message");
  assert.equal(reply.data.id, "caller-visible-id");
  assert.equal(reply.data.result.serverInfo.name, "repo-rescue-mcp");
});

test("the HTTP transport exposes exactly the reviewed four-tool platform surface", async (t) => {
  const { baseUrl } = await startServer(t);
  const session = await openSession(baseUrl);
  t.after(() => session.controller.abort());
  const endpoint = (await session.nextEvent()).data;
  const accepted = await postRpc(baseUrl, endpoint, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  assert.equal(accepted.status, 202);
  const reply = await session.nextEvent();
  assert.deepEqual(
    reply.data.result.tools.map((tool) => tool.name),
    ["rescue_python_snippet", "start_prepare_github_repair", "get_repair_job", "start_verify_github_patch"],
  );
  assert.equal(reply.data.result.tools[0].inputSchema.properties.test_cases.type, "array");
  assert.equal(reply.data.result.tools[3].inputSchema.properties.changes.type, "array");
});

test("message POSTs reject wrong credentials, content types, and unknown sessions", async (t) => {
  const { baseUrl } = await startServer(t);
  const session = await openSession(baseUrl);
  t.after(() => session.controller.abort());
  const endpoint = (await session.nextEvent()).data;
  const wrongToken = await postRpc(baseUrl, endpoint, { jsonrpc: "2.0", id: 1, method: "ping" }, "wrong-token");
  assert.equal(wrongToken.status, 401);
  const wrongType = await fetch(new URL(endpoint, baseUrl), {
    method: "POST",
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, "Content-Type": "text/plain" },
    body: "{}",
  });
  assert.equal(wrongType.status, 415);
  const unknown = await postRpc(baseUrl, "/messages/?session_id=missing", { jsonrpc: "2.0", id: 1, method: "ping" });
  assert.equal(unknown.status, 404);
});

test("repository tools fail closed when the GitHub credential is absent", async (t) => {
  const { baseUrl } = await startServer(t);
  const session = await openSession(baseUrl);
  t.after(() => session.controller.abort());
  const endpoint = (await session.nextEvent()).data;
  await postRpc(baseUrl, endpoint, {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "start_prepare_github_repair", arguments: { repo_url: "https://github.com/wenjieding327/repo-rescue-canary" } },
  });
  const reply = await session.nextEvent();
  assert.equal(reply.data.id, 3);
  assert.equal(reply.data.result.isError, false);
  const value = JSON.parse(reply.data.result.content[0].text);
  assert.equal(value.ok, false);
  assert.equal(value.status, "configuration_required");
});

test("chunked oversized uploads receive one rejection and leave the worker usable", { timeout: 15000 }, async (t) => {
  const { baseUrl } = await startServer(t);
  const session = await openSession(baseUrl);
  t.after(() => session.controller.abort());
  const endpoint = (await session.nextEvent()).data;
  const status = await new Promise((resolve, reject) => {
    const upload = httpRequest(new URL(endpoint, baseUrl), {
      method: "POST",
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, "Content-Type": "application/json" },
    }, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode));
    });
    upload.on("error", reject);
    // Multiple data chunks after the first rejected chunk reproduced a process crash.
    for (let i = 0; i < 32; i++) upload.write(Buffer.alloc(65536, 120));
    upload.end();
  });
  assert.equal(status, 413);
  assert.equal((await fetch(`${baseUrl}/healthz`)).status, 200);
  assert.equal((await postRpc(baseUrl, endpoint, { jsonrpc: "2.0", id: 5, method: "ping" })).status, 202);
  assert.deepEqual((await session.nextEvent()).data, { jsonrpc: "2.0", id: 5, result: {} });
});

test("sessions with identical request ids receive only their own replies", { timeout: 15000 }, async (t) => {
  const { baseUrl } = await startServer(t);
  const first = await openSession(baseUrl);
  const second = await openSession(baseUrl);
  t.after(() => { first.controller.abort(); second.controller.abort(); });
  const firstEndpoint = (await first.nextEvent()).data;
  const secondEndpoint = (await second.nextEvent()).data;
  await Promise.all([
    postRpc(baseUrl, firstEndpoint, { jsonrpc: "2.0", id: 1, method: "ping" }),
    postRpc(baseUrl, secondEndpoint, { jsonrpc: "2.0", id: 1, method: "tools/list" }),
  ]);
  assert.deepEqual((await first.nextEvent()).data.result, {});
  assert.equal((await second.nextEvent()).data.result.tools.length, 4);
});

test("invalid JSON-RPC and direct hidden tools cannot bypass the gateway", { timeout: 15000 }, async (t) => {
  const { baseUrl } = await startServer(t);
  const session = await openSession(baseUrl);
  t.after(() => session.controller.abort());
  const endpoint = (await session.nextEvent()).data;
  for (const message of [[], null, { jsonrpc: "2.0", id: {} }, { jsonrpc: "2.0", method: 1 }]) {
    assert.equal((await postRpc(baseUrl, endpoint, message)).status, 400);
  }
  await postRpc(baseUrl, endpoint, {
    jsonrpc: "2.0", id: 6, method: "tools/call",
    params: { name: "windows_environment_probe", arguments: {} },
  });
  const reply = (await session.nextEvent()).data;
  assert.equal(reply.result.isError, true);
  assert.equal(JSON.parse(reply.result.content[0].text).status, "tool_unavailable");
});

test("HTTP plugin endpoints require header authentication and reject hidden tools", async (t) => {
  const { baseUrl } = await startServer(t);
  for (const name of ["rescue_python_snippet", "start_prepare_github_repair", "get_repair_job", "start_verify_github_patch"]) {
    assert.equal((await postTool(baseUrl, name, {}, { Authorization: "" })).status, 401);
    assert.equal((await postTool(baseUrl, name, {}, { Origin: "https://example.com" })).status, 403);
  }
  assert.equal((await postTool(baseUrl, "windows_environment_probe", {})).status, 404);
  assert.equal((await postTool(baseUrl, "rescue_python_snippet?token=" + ACCESS_TOKEN, {}, { Authorization: "" })).status, 401);
  assert.equal((await fetch(`${baseUrl}/api/tools/rescue_python_snippet`)).status, 404);
});

test("HTTP plugins preserve real snippet repair and unsafe import evidence", { timeout: 60000 }, async (t) => {
  const { baseUrl } = await startServer(t);
  const fixed = await httpToolPayload(await postTool(baseUrl, "rescue_python_snippet", {
    original_code: "print(1 / 0)", candidate_code: "print(0)",
    test_cases: [{ name: "output", expected_stdout: "0" }],
  }));
  assert.equal(fixed.fix_verified, true);
  const rejected = await httpToolPayload(await postTool(baseUrl, "rescue_python_snippet", {
    original_code: "import os\nprint(os.getcwd())", candidate_code: "import os\nprint(os.getcwd())",
    test_cases: [{ name: "output", expected_stdout: "0" }],
  }));
  assert.equal(rejected.fix_verified, false);
  assert.match(JSON.stringify(rejected), /PermissionError/);
});

test("HTTP snippet JSON-string cases preserve independent-oracle execution and missing-oracle failure", { timeout: 60000 }, async (t) => {
  const { baseUrl } = await startServer(t);
  const args = { original_code: "numbers = [1, 2, 3]\nprint(numbers[3])", candidate_code: "numbers = [1, 2, 3]\nprint(numbers[2])" };
  const fixed = await httpToolPayload(await postTool(baseUrl, "rescue_python_snippet", {
    ...args, test_cases: JSON.stringify([{ name: "index", expected_stdout: "3" }]),
  }));
  assert.equal(fixed.fix_verified, true);
  assert.equal(fixed.before_failed, true);
  assert.equal(fixed.case_counts.executed, 1);
  assert.equal(fixed.test_results[0].after.stdout, "3\n");
  const unverified = await httpToolPayload(await postTool(baseUrl, "rescue_python_snippet", {
    ...args, test_cases: JSON.stringify([{ name: "no-oracle" }]),
  }));
  assert.equal(unverified.fix_verified, false);
  assert.equal(unverified.oracle_backed, false);
});

test("HTTP JSON-array conversion rejects malformed or non-array strings without echoing caller content", async (t) => {
  const { baseUrl } = await startServer(t);
  for (const [name, field] of [["rescue_python_snippet", "test_cases"], ["start_verify_github_patch", "changes"]]) {
    for (const encoded of ["invalid-SECRET-SENTINEL", "{}", "null", "true", "1", '"[]"']) {
      const result = await postTool(baseUrl, name, { [field]: encoded });
      assert.equal(result.status, 400);
      assert.deepEqual(await result.json(), { ok: false, error: "argument_must_be_a_json_array", field });
    }
    assert.equal((await postTool(baseUrl, name, { [field]: "[".repeat(2 * 1024 * 1024) })).status, 413);
    assert.equal((await postTool(baseUrl, name, { [field]: "[]" }, { Authorization: "" })).status, 401);
  }
  assert.equal((await fetch(`${baseUrl}/healthz`)).status, 200);
});

test("decoded snippet cases still reach the original metadata and case-count validator", async (t) => {
  const { baseUrl } = await startServer(t);
  for (const cases of [[null], [{ expected_stdout: {} }], Array.from({ length: 5 }, () => ({ name: "case" }))]) {
    const result = await httpToolPayload(await postTool(baseUrl, "rescue_python_snippet", {
      original_code: "print(1 / 0)", candidate_code: "print(0)", test_cases: JSON.stringify(cases),
    }));
    assert.equal(result.status, "invalid_request");
    assert.equal(result.fix_verified, false);
    assert.equal(result.case_counts.executed, 0);
  }
});

test("SSE requests keep the native-array contract and never apply HTTP string conversion", async (t) => {
  const { baseUrl } = await startServer(t);
  const session = await openSession(baseUrl);
  t.after(() => session.controller.abort());
  const endpoint = (await session.nextEvent()).data;
  await postRpc(baseUrl, endpoint, {
    jsonrpc: "2.0", id: 71, method: "tools/call", params: {
      name: "rescue_python_snippet", arguments: {
        original_code: "print(1 / 0)", candidate_code: "print(0)",
        test_cases: JSON.stringify([{ name: "explicit", expected_stdout: "0" }]),
      },
    },
  });
  const result = JSON.parse((await session.nextEvent()).data.result.content[0].text);
  assert.equal(result.status, "invalid_request");
  assert.equal(result.case_counts.executed, 0);
  assert.match(result.error, /test_cases must be an array/);
});

test("HTTP verify string changes reach unchanged preflight, cannot inject tool selection, and keep native arrays compatible", async (t) => {
  const { baseUrl } = await startServer(t, { REPO_RESCUE_GITHUB_TOKEN: "mock-only-token-for-local-preflight-no-network" });
  const args = {
    repo_url: "https://github.com/wenjieding327/repo-rescue-canary", preparation_job_id: "N".repeat(43),
    expected_commit: "a".repeat(40), expected_baseline_sha256: "b".repeat(64),
    changes: [{ path: "src/repo_rescue_canary/parser.py", content: "def normalize_title(value):\n    return value.strip() or 'untitled'\n" }],
  };
  const original = await httpToolPayload(await postTool(baseUrl, "start_verify_github_patch", args), true);
  const converted = await httpToolPayload(await postTool(baseUrl, "start_verify_github_patch", {
    ...args, changes: JSON.stringify(args.changes),
  }), true);
  assert.deepEqual(converted, original);
  assert.equal(converted.ok, false);
  assert.equal(converted.status, "preparation_required");
  assert.equal(converted.job, undefined);
  const rejected = await httpToolPayload(await postTool(baseUrl, "start_verify_github_patch", {
    ...args, changes: JSON.stringify([{ path: "src/app.py", content: "fixed", method: "tools/list" }]),
  }));
  assert.equal(rejected.status, "invalid_request");
  const injected = await postTool(baseUrl, "start_verify_github_patch", {
    ...args, changes: JSON.stringify(args.changes), method: "tools/list", params: { name: "windows_environment_probe" },
  });
  const injectedEnvelope = await injected.json();
  assert.equal(JSON.parse(JSON.parse(injectedEnvelope.result_json).content[0].text).status, "invalid_request");
  assert.doesNotMatch(injectedEnvelope.result_json, /inputSchema/);
  assert.equal((await postTool(baseUrl, "windows_environment_probe", { changes: "[]" })).status, 404);
  const wrongRoute = await httpToolPayload(await postTool(baseUrl, "get_repair_job", { job_id: "N".repeat(43), changes: "not JSON" }));
  assert.equal(wrongRoute.status, "invalid_request");
  assert.match(wrongRoute.message, /Job polling accepts only/);
});

test("HTTP contracts alone use JSON strings for the two nested fields, with no default oracle", { timeout: 15000 }, () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const environment = {};
  for (const name of ["PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE"]) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  execFileSync(process.execPath, [fileURLToPath(new URL("../scripts/build-http-plugin-contracts.mjs", import.meta.url))], {
    cwd: root, env: environment, timeout: 10000, windowsHide: true,
  });
  for (const [title, tool, field] of [
    ["rescue_snippet", "rescue_python_snippet", "test_cases"],
    ["rescue_verify", "start_verify_github_patch", "changes"],
  ]) {
    const contract = JSON.parse(readFileSync(new URL(`../dist/http-plugins/${title}.json`, import.meta.url), "utf8"));
    const post = contract.paths[`/api/tools/${tool}`].post;
    const schema = post.requestBody.content["application/json"].schema.properties[field];
    assert.equal(schema.type, "string");
    assert.equal(Object.hasOwn(schema, "default"), false);
    assert.equal(Object.hasOwn(schema, "items"), false);
    assert.match(schema.description, /JSON-encoded array/);
    assert.equal(post.operationId, title);
    assert.deepEqual(post.responses["200"].content["application/json"].schema.required, ["is_error", "result_json", "receipt_url"]);
    assert.equal(post.responses["200"].content["application/json"].schema.properties.receipt_url.type, "string");
    assert.match(post.responses["200"].content["application/json"].schema.properties.result_json.description,
      /receipt_url mirror/);
  }
});

test("HTTP plugin repo tools fail closed and never interpret HTTP 200 as repair success", async (t) => {
  const { baseUrl } = await startServer(t);
  const payload = await httpToolPayload(await postTool(baseUrl, "start_prepare_github_repair", {
    repo_url: "https://github.com/wenjieding327/repo-rescue-canary",
  }));
  assert.equal(payload.ok, false);
  assert.equal(payload.status, "configuration_required");
});

test("HTTP plugin arguments cannot select a different tool or protocol method", async (t) => {
  const { baseUrl } = await startServer(t);
  const response = await postTool(baseUrl, "get_repair_job", {
    jsonrpc: "2.0", method: "tools/list", params: { name: "windows_environment_probe" },
    job_id: "nonexistent-job",
  });
  assert.equal(response.status, 200);
  const envelope = await response.json();
  // The configured route runs the repository preflight, not injected tools/list.
  assert.equal(JSON.parse(JSON.parse(envelope.result_json).content[0].text).status, "configuration_required");
  assert.doesNotMatch(envelope.result_json, /inputSchema/);
});

test("HTTP plugin parsing rejects malformed, oversized and non-object bodies", async (t) => {
  const { baseUrl } = await startServer(t);
  for (const body of [null, [], "text"]) {
    assert.equal((await postTool(baseUrl, "get_repair_job", body)).status, 400);
  }
  assert.equal((await postTool(baseUrl, "get_repair_job", {}, { "Content-Type": "text/plain" })).status, 415);
  assert.equal((await postTool(baseUrl, "get_repair_job", { value: "x".repeat(2 * 1024 * 1024) })).status, 413);
  assert.equal((await fetch(`${baseUrl}/healthz`)).status, 200);
});
