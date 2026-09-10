import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { httpBridge, main, pollToTerminal } from "../scripts/live_actions_bridge_smoke.mjs";

const TOKEN = "mock-only-gateway-token-not-a-real-credential";
const PREPARE_CAP = "P".repeat(43);
const VERIFY_CAP = "V".repeat(43);
const ORIGIN = "https://gateway.example";
const silent = { write() {} };

function response(result, transform = (value) => value) {
  const envelope = {
    is_error: false,
    result_json: JSON.stringify({ content: [{ type: "text", text: JSON.stringify(result) }] }),
  };
  return new Response(JSON.stringify(transform(envelope)), { headers: { "Content-Type": "application/json" } });
}

function bridge(fetchImpl, base = ORIGIN, token = TOKEN) {
  return httpBridge(base, { token, fetchImpl, stderr: silent });
}

test("HTTP smoke validates target and credential before making any request", () => {
  let called = false;
  const fetchImpl = async () => { called = true; throw new Error("must not call"); };
  for (const target of ["bad-url", "http://gateway.example", "https://user:password@gateway.example",
    "https://gateway.example/path", "https://gateway.example/?key=secret", "https://gateway.example/#secret"]) {
    assert.throws(() => bridge(fetchImpl, target), /smoke target/);
  }
  for (const token of [undefined, "", "short", `${TOKEN}\r\nInjected: yes`, `${TOKEN} with spaces`]) {
    assert.throws(() => httpBridge(ORIGIN, { fetchImpl, token }), /gateway credential/);
  }
  assert.equal(called, false);
});

test("HTTP smoke sends only explicit tools and forbids following credential-bearing redirects", async () => {
  const calls = [];
  const client = bridge(async (url, options) => {
    calls.push({ url: String(url), options });
    assert.equal(options.redirect, "error");
    assert.equal(options.method, "POST");
    assert.equal(options.headers.Authorization, `Bearer ${TOKEN}`);
    assert.ok(options.signal instanceof AbortSignal);
    return response({ ok: true, job: { job_id: VERIFY_CAP } });
  });
  await client.get(PREPARE_CAP, 15);
  await client.startVerify(PREPARE_CAP, { preparation_job_id: "untrusted-override", changes: [] });
  assert.deepEqual(calls.map((call) => call.url), [
    `${ORIGIN}/api/tools/get_repair_job`, `${ORIGIN}/api/tools/start_verify_github_patch`,
  ]);
  assert.equal(JSON.parse(calls[1].options.body).preparation_job_id, PREPARE_CAP);
  await assert.rejects(client.start("hidden-tool", {}), /Unexpected preparation stage/);
  assert.equal(calls.length, 2);
  for (const status of [301, 302, 303, 307, 308, 401, 500]) {
    await assert.rejects(bridge(async () => new Response(TOKEN, {
      status, headers: { Location: "https://other.example/collect" },
    })).get(PREPARE_CAP, 15), /^Error: HTTP tool request failed\.$/);
  }
  const redirected = response({ ok: true });
  Object.defineProperty(redirected, "redirected", { value: true });
  await assert.rejects(bridge(async () => redirected).get(PREPARE_CAP, 15), /HTTP tool request failed/);
});

test("HTTP smoke checks the refusal before dispatching the canary", async () => {
  const calls = [];
  const client = bridge(async (_url, options) => {
    calls.push(JSON.parse(options.body));
    return response(calls.length === 1 ? { ok: false } : { ok: true, job: { job_id: PREPARE_CAP } });
  });
  await client.start("prepare", { repo_url: "https://github.com/wenjieding327/repo-rescue-canary" });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].repo_url, "https://github.com/example/not-allowed");
  let attempted = 0;
  await assert.rejects(bridge(async () => {
    attempted += 1;
    return response({ ok: false, job: { job_id: PREPARE_CAP } });
  }).start("prepare", {}), /not rejected before dispatch/);
  assert.equal(attempted, 1);
});

test("malformed, malicious, and oversized HTTP responses fail without echoing response or network secrets", async () => {
  const replies = [
    () => new Response(TOKEN),
    () => new Response(`{"${TOKEN}":invalid}`, { headers: { "Content-Type": "application/json" } }),
    () => response({}, (value) => ({ ...value, is_error: true })),
    () => response({}, (value) => ({ ...value, result_json: TOKEN })),
    () => response({}, (value) => ({ ...value, result_json: JSON.stringify({ isError: true, content: [] }) })),
    () => response({}, (value) => ({ ...value, result_json: JSON.stringify({ content: [{ type: "image", text: TOKEN }] }) })),
    () => response({ ok: "true" }),
    () => response(null),
    () => response([]),
    () => new Response("x".repeat(32 * 1024 * 1024 + 1), { headers: { "Content-Type": "application/json" } }),
  ];
  for (const reply of replies) {
    await assert.rejects(bridge(async () => reply()).get(PREPARE_CAP, 15), /^Error: HTTP tool request failed\.$/);
  }
  await assert.rejects(bridge(async () => {
    const error = new Error(`${TOKEN}/${PREPARE_CAP}`);
    error.name = TOKEN;
    throw error;
  }).get(PREPARE_CAP, 15), /^Error: HTTP tool request failed\.$/);
});

test("job polling logs only known statuses, never arbitrary response fields or job capabilities", async () => {
  let output = "";
  const stderr = { write(value) { output += value; } };
  await assert.rejects(pollToTerminal({}, "prepare", {
    ok: true, job: { job_id: PREPARE_CAP, status: `${TOKEN}/${PREPARE_CAP}` },
  }, stderr), /unknown status/);
  assert.equal(output, "");
  await pollToTerminal({ get: async () => ({ ok: true, job: { job_id: PREPARE_CAP, status: "succeeded", terminal: true } }) },
    "prepare", { ok: true, job: { job_id: PREPARE_CAP, status: "queued", terminal: false } }, stderr);
  assert.equal(output, "prepare: queued (poll 1)\n");
  for (const status of ["dispatching", "dispatch_unknown", "running", "collecting_artifact", "poll_deferred"]) {
    await pollToTerminal({ get: async () => ({ ok: true, job: { job_id: PREPARE_CAP, status: "succeeded", terminal: true } }) },
      "prepare", { ok: true, job: { job_id: PREPARE_CAP, status, terminal: false } }, silent);
  }
});

test("CLI reports only a fixed failure message, without URL secrets or exception details", () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("../scripts/live_actions_bridge_smoke.mjs", import.meta.url)),
    `http://user:${TOKEN}@gateway.example/`], { env: {}, encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "live bridge smoke failed; no credentials or job capabilities were logged.\n");
});

function smokeFixtures() {
  const repository = { slug: "wenjieding327/repo-rescue-canary", commit: "a".repeat(40) };
  const baselineHash = "b".repeat(64);
  const patchHash = "c".repeat(64);
  const head = "d".repeat(40);
  const baseline = { backend: "docker", command: "python -m pytest -q", preparation_baseline_sha256: baselineHash,
    execution: { exit_code: 1, pytest_attestation: { passed: 2, failed: 1 } } };
  const preparation = { ok: true, job: { job_id: PREPARE_CAP, status: "succeeded", terminal: true,
    result: { ok: true, preparation: { status: "repair_ready", repairable: true, repository,
      baseline_sha256: baselineHash, baseline }, github_actions: { head_sha: head, workflow_run_id: 1001 } } } };
  const repair = { run_id: "run-mock", status: "verified_repair", verified_repair: true, repository, baseline,
    final_verification: { command: "python -m pytest -q", execution: { exit_code: 0, pytest_attestation: { passed: 3, failed: 0 } } },
    changed_files: ["src/repo_rescue_canary/parser.py"], patch_sha256: patchHash };
  const verification = { ok: true, job: { job_id: VERIFY_CAP, status: "succeeded", terminal: true,
    result: { ok: true, repair, github_actions: { head_sha: head, workflow_run_id: 1002,
      artifact_contents: { patch: "mock patch", evidence: JSON.stringify(repair), report: "Report for run-mock" },
      files: { "repair.patch": { sha256: patchHash }, [TOKEN]: { credential: PREPARE_CAP } },
      html_url: `https://evil.example/${TOKEN}`, artifact_digest: VERIFY_CAP } } } };
  return [response({ ok: false }), response(preparation), verification];
}

test("successful smoke prints validated public evidence only, omitting capabilities and arbitrary artifact metadata", async () => {
  const fixtures = smokeFixtures();
  const verification = fixtures.pop();
  fixtures.push(response(verification));
  let output = "";
  await main({ baseUrl: ORIGIN, environment: { REPO_RESCUE_HTTP_ACCESS_TOKEN: TOKEN },
    fetchImpl: async () => fixtures.shift(), stdout: { write(value) { output += value; } }, stderr: silent });
  const summary = JSON.parse(output);
  assert.equal(summary.ok, true);
  assert.equal(summary.prepare_run_id, 1001);
  assert.equal(summary.verify_run_id, 1002);
  assert.equal(summary.artifact_url, "https://github.com/wenjieding327/repo-rescue-mcp/actions/runs/1002");
  for (const secret of [TOKEN, PREPARE_CAP, VERIFY_CAP, "evil.example"]) assert.equal(output.includes(secret), false);
});

test("malicious public evidence identifiers abort before writing the success report", async () => {
  const fixtures = smokeFixtures();
  const verification = fixtures.pop();
  verification.job.result.github_actions.workflow_run_id = TOKEN;
  fixtures.push(response(verification));
  let output = "";
  await assert.rejects(main({ baseUrl: ORIGIN, environment: { REPO_RESCUE_HTTP_ACCESS_TOKEN: TOKEN },
    fetchImpl: async () => fixtures.shift(), stdout: { write(value) { output += value; } }, stderr: silent }), /invalid public run ID/);
  assert.equal(output, "");
});
