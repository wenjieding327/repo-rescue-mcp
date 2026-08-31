import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  ActionsBridgeError,
  GitHubActionsBridge,
  encodeDispatchPayload,
  extractBridgeArtifact,
} from "../actions-bridge.mjs";

const WORKFLOW_ID = 8842;
const RUN_ID = 99117;
const ARTIFACT_ID = 77221;
const HEAD_SHA = "a".repeat(40);
const JOB_ID = "A".repeat(43);
const PREPARATION_JOB_ID = "P".repeat(43);
const REQUEST_ID = "R".repeat(43);
const REPOSITORY = "wenjieding327/repo-rescue-mcp";
const WORKFLOW_PATH = ".github/workflows/repo-rescue-actions-bridge.yml";
const FIXED_NOW = Date.parse("2026-08-31T12:00:00Z");
const PATCH_TEXT = "--- a/src/app.py\n+++ b/src/app.py\n@@ -1 +1 @@\n-broken\n+fixed\n";

function u16(value) {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value);
  return buffer;
}

function u32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value);
  return buffer;
}

function storedZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, raw] of Object.entries(entries)) {
    const filename = Buffer.from(name, "utf8");
    const content = Buffer.from(raw);
    const local = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0), u32(0),
      u32(content.length), u32(content.length), u16(filename.length), u16(0), filename, content,
    ]);
    const central = Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0), u32(0),
      u32(content.length), u32(content.length), u16(filename.length), u16(0), u16(0),
      u16(0), u16(0), u32(0), u32(offset), filename,
    ]);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const centralBytes = Buffer.concat(centrals);
  const end = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(centrals.length), u16(centrals.length),
    u32(centralBytes.length), u32(offset), u16(0),
  ]);
  return Buffer.concat([...locals, centralBytes, end]);
}

function jsonResponse(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function successfulFetch(result, {
  conclusion = "success",
  firstRunResponse = null,
  verificationFiles = "valid",
  runPath = `${WORKFLOW_PATH}@refs/heads/main`,
} = {}) {
  let dispatchBody = null;
  let zip = null;
  let runGets = 0;
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url);
    calls.push({ url: parsed, options });
    if (parsed.pathname.endsWith(`/actions/workflows/repo-rescue-actions-bridge.yml`)) {
      return jsonResponse({ id: WORKFLOW_ID, path: WORKFLOW_PATH, name: "RepoRescue isolated repair bridge", state: "active" });
    }
    if (parsed.pathname.endsWith(`/actions/workflows/${WORKFLOW_ID}/dispatches`)) {
      dispatchBody = JSON.parse(options.body);
      return jsonResponse({ workflow_run_id: RUN_ID, run_url: "ignored", html_url: "ignored" });
    }
    if (parsed.pathname.endsWith(`/actions/runs/${RUN_ID}`)) {
      runGets += 1;
      if (runGets === 1 && firstRunResponse) return firstRunResponse();
      return jsonResponse({
        id: RUN_ID,
        workflow_id: WORKFLOW_ID,
        event: "workflow_dispatch",
        run_attempt: 1,
        head_branch: "main",
        head_sha: HEAD_SHA,
        path: runPath,
        created_at: new Date(FIXED_NOW).toISOString(),
        status: "completed",
        conclusion,
        html_url: `https://github.com/${REPOSITORY}/actions/runs/${RUN_ID}`,
      });
    }
    if (parsed.pathname.endsWith(`/actions/runs/${RUN_ID}/artifacts`)) {
      const payloadSha = createHash("sha256").update(dispatchBody.inputs.payload).digest("hex");
      let extraFiles = {};
      if (dispatchBody.inputs.mode === "verify" && result.ok === true && verificationFiles !== "missing") {
        extraFiles = {
          "run/repair.patch": verificationFiles === "malformed_utf8" ? Buffer.from([0xff, 0xfe]) : PATCH_TEXT,
          "run/evidence.json": JSON.stringify(result.repair),
          "run/report.md": `# Evidence\n\nRun ID: ${result.repair.run_id}\n`,
        };
      }
      zip = storedZip({
        "result.json": JSON.stringify({
          request_id: dispatchBody.inputs.request_id,
          mode: dispatchBody.inputs.mode,
          payload_sha256: payloadSha,
          github_run_id: String(RUN_ID),
          github_sha: HEAD_SHA,
          result,
        }),
        ...extraFiles,
      });
      return jsonResponse({
        total_count: 1,
        artifacts: [{
          id: ARTIFACT_ID,
          name: `repo-rescue-${dispatchBody.inputs.request_id}`,
          expired: false,
          size_in_bytes: zip.length,
          digest: `sha256:${createHash("sha256").update(zip).digest("hex")}`,
          workflow_run: { id: RUN_ID, head_sha: HEAD_SHA },
        }],
      });
    }
    if (parsed.pathname.endsWith(`/actions/artifacts/${ARTIFACT_ID}/zip`)) {
      return new Response(zip, { status: 200, headers: { "content-type": "application/zip" } });
    }
    throw new Error(`Unexpected mock request: ${options.method || "GET"} ${parsed.pathname}`);
  };
  return { fetchImpl, calls, get dispatchBody() { return dispatchBody; } };
}

function bridgeWith(fetchImpl, overrides = {}) {
  return new GitHubActionsBridge({
    token: "test-secret-value-not-a-token",
    repository: REPOSITORY,
    workflow: "repo-rescue-actions-bridge.yml",
    ref: "main",
    allowedRepositories: ["example/project"],
    fetchImpl,
    now: () => FIXED_NOW,
    idFactory: () => JOB_ID,
    requestIdFactory: () => REQUEST_ID,
    minimumPollMs: 250,
    ...overrides,
  });
}

function seedPreparation(bridge, overrides = {}) {
  bridge.jobs.set(PREPARATION_JOB_ID, {
    jobId: PREPARATION_JOB_ID,
    requestId: PREPARATION_JOB_ID,
    mode: "prepare",
    operation: "prepare_github_repair",
    status: "succeeded",
    terminal: true,
    result: {
      ok: true,
      preparation: {
        repairable: true,
        repository: { slug: "example/project", commit: "b".repeat(40) },
        baseline_sha256: "c".repeat(64),
      },
    },
    completedAt: FIXED_NOW,
    dispatchedAt: FIXED_NOW,
    ...overrides,
  });
}

test("dispatches, polls, verifies artifact binding, and returns preparation wire shape", async () => {
  const mock = successfulFetch({ ok: true, preparation: { status: "repair_ready" } });
  const bridge = bridgeWith(mock.fetchImpl);
  const started = await bridge.start("prepare", { repo_url: "https://github.com/example/project" });
  assert.equal(started.job.job_id, JOB_ID);
  assert.notEqual(mock.dispatchBody.inputs.request_id, started.job.job_id);
  assert.equal(mock.dispatchBody.inputs.request_id, REQUEST_ID);
  assert.equal(started.job.terminal, false);
  assert.equal(mock.dispatchBody.return_run_details, true);
  assert.equal(mock.dispatchBody.ref, "main");

  const completed = await bridge.get(JOB_ID);
  assert.equal(completed.job.status, "succeeded");
  assert.equal(completed.job.terminal, true);
  assert.equal(completed.job.result.preparation.status, "repair_ready");
  assert.equal(completed.job.result.github_actions.workflow_run_id, RUN_ID);
  assert.equal(completed.job.result.github_actions.head_sha, HEAD_SHA);
  assert.equal(JSON.stringify(completed.job.result).includes(JOB_ID), false);
  const dispatchCall = mock.calls.find((call) => call.url.pathname.endsWith("/dispatches"));
  assert.equal(dispatchCall.options.headers["X-GitHub-Api-Version"], "2026-03-10");
});

test("accepts only the documented GitHub workflow run path shapes", async () => {
  for (const runPath of [WORKFLOW_PATH, `${WORKFLOW_PATH}@main`, `${WORKFLOW_PATH}@refs/heads/main`]) {
    const mock = successfulFetch({ ok: true, preparation: { status: "repair_ready" } }, { runPath });
    const bridge = bridgeWith(mock.fetchImpl);
    await bridge.start("prepare", { repo_url: "https://github.com/example/project" });
    const completed = await bridge.get(JOB_ID);
    assert.equal(completed.job.status, "succeeded");
  }

  const mock = successfulFetch(
    { ok: true, preparation: { status: "repair_ready" } },
    { runPath: `${WORKFLOW_PATH}@evil` },
  );
  const bridge = bridgeWith(mock.fetchImpl);
  await bridge.start("prepare", { repo_url: "https://github.com/example/project" });
  const rejected = await bridge.get(JOB_ID);
  assert.equal(rejected.job.status, "failed");
  assert.equal(rejected.job.result.status, "provider_protocol_error");
});

test("preserves a controlled failed workflow result instead of inventing repair evidence", async () => {
  const mock = successfulFetch(
    { ok: false, status: "invalid_request", error_type: "ValueError", message: "rejected" },
    { conclusion: "failure" },
  );
  const bridge = bridgeWith(mock.fetchImpl);
  await bridge.start("verify", {
    repo_url: "https://github.com/example/project",
    expected_commit: "b".repeat(40),
    expected_baseline_sha256: "c".repeat(64),
    changes: [{ path: "src/app.py", content: "print('fixed')" }],
  });
  const completed = await bridge.get(JOB_ID);
  assert.equal(completed.job.status, "failed");
  assert.equal(completed.job.result.ok, false);
  assert.equal(completed.job.result.status, "invalid_request");
  assert.deepEqual(Object.keys(completed.job.result.github_actions.files), ["result.json"]);
});

test("returns the real bounded patch and evidence contents for a successful verification", async () => {
  const repair = {
    run_id: "20260831T120000Z-1234abcd",
    status: "verified_repair",
    verified_repair: true,
    repository: { slug: "example/project", commit: "b".repeat(40) },
    baseline: { command: "python -m pytest -q" },
    final_verification: { command: "python -m pytest -q" },
    patch_sha256: createHash("sha256").update(PATCH_TEXT).digest("hex"),
  };
  const mock = successfulFetch({ ok: true, repair });
  const bridge = bridgeWith(mock.fetchImpl);
  await bridge.start("verify", {
    repo_url: "https://github.com/example/project",
    expected_commit: "b".repeat(40),
    expected_baseline_sha256: "c".repeat(64),
    changes: [{ path: "src/app.py", content: "fixed" }],
  });
  const completed = await bridge.get(JOB_ID);
  assert.equal(completed.job.status, "succeeded");
  assert.equal(completed.job.result.repair.verified_repair, true);
  assert.equal(completed.job.result.github_actions.artifact_contents.patch, PATCH_TEXT);
  assert.match(completed.job.result.github_actions.artifact_contents.evidence, /verified_repair/);
  assert.match(completed.job.result.github_actions.artifact_contents.report, /20260831T120000Z-1234abcd/);
});

test("rejects successful verification artifacts with missing or malformed evidence files", async () => {
  const repair = {
    run_id: "20260831T120000Z-1234abcd",
    status: "verified_repair",
    verified_repair: true,
    repository: { slug: "example/project", commit: "b".repeat(40) },
    baseline: { command: "python -m pytest -q" },
    final_verification: { command: "python -m pytest -q" },
    patch_sha256: createHash("sha256").update(PATCH_TEXT).digest("hex"),
  };
  for (const verificationFiles of ["missing", "malformed_utf8"]) {
    const mock = successfulFetch({ ok: true, repair }, { verificationFiles });
    const bridge = bridgeWith(mock.fetchImpl);
    await bridge.start("verify", {
      repo_url: "https://github.com/example/project",
      expected_commit: "b".repeat(40),
      expected_baseline_sha256: "c".repeat(64),
      changes: [{ path: "src/app.py", content: "fixed" }],
    });
    const completed = await bridge.get(JOB_ID);
    assert.equal(completed.job.status, "failed");
    assert.equal(completed.job.result.status, "artifact_invalid");
  }
});

test("transient poll errors remain retryable and respect the same remote job", async () => {
  let now = FIXED_NOW;
  const mock = successfulFetch(
    { ok: true, preparation: { status: "repair_ready" } },
    { firstRunResponse: () => jsonResponse({ message: "busy" }, 503, { "retry-after": "1" }) },
  );
  const bridge = bridgeWith(mock.fetchImpl, {
    now: () => now,
    sleep: async (milliseconds) => { now += milliseconds; },
  });
  await bridge.start("prepare", { repo_url: "https://github.com/example/project" });
  const deferred = await bridge.get(JOB_ID);
  assert.equal(deferred.job.terminal, false);
  assert.equal(deferred.job.status, "poll_deferred");
  now += 1_000;
  const completed = await bridge.get(JOB_ID);
  assert.equal(completed.job.status, "succeeded");
});

test("concurrent starts reserve capacity without sharing one caller's job capability", async () => {
  let dispatches = 0;
  let ids = 0;
  const fetchImpl = async (url) => {
    const path = new URL(url).pathname;
    if (path.endsWith("/actions/workflows/repo-rescue-actions-bridge.yml")) {
      return jsonResponse({ id: WORKFLOW_ID, path: WORKFLOW_PATH, name: "bridge", state: "active" });
    }
    if (path.endsWith(`/actions/workflows/${WORKFLOW_ID}/dispatches`)) {
      dispatches += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return jsonResponse({ workflow_run_id: RUN_ID + dispatches });
    }
    throw new Error(`Unexpected request ${path}`);
  };
  const bridge = bridgeWith(fetchImpl, {
    idFactory: () => String.fromCharCode(65 + ids++).repeat(43),
    requestIdFactory: () => String.fromCharCode(75 + ids).repeat(43),
    maxActive: 1,
    maxStartsPerMinute: 1,
    allowedRepositories: [
      "example/same",
      "example/different-0",
      "example/different-1",
      "example/different-2",
      "example/different-3",
    ],
  });
  const duplicates = await Promise.allSettled(Array.from({ length: 5 }, () => (
    bridge.start("prepare", { repo_url: "https://github.com/example/same" })
  )));
  assert.equal(dispatches, 1);
  assert.equal(duplicates.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(
    duplicates.filter((item) => item.status === "rejected").every((item) => item.reason.code === "capacity_exceeded"),
    true,
  );
});

test("verification requires and consumes one matching live preparation capability", async () => {
  const mock = successfulFetch({ ok: false, status: "not-polled" }, { conclusion: "failure" });
  const bridge = bridgeWith(mock.fetchImpl);
  seedPreparation(bridge);
  const args = {
    repo_url: "https://github.com/example/project",
    expected_commit: "b".repeat(40),
    expected_baseline_sha256: "c".repeat(64),
    changes: [{ path: "src/app.py", content: "fixed" }],
  };
  const first = await bridge.startVerify(PREPARATION_JOB_ID, args);
  const retry = await bridge.startVerify(PREPARATION_JOB_ID, { ...args });
  assert.equal(first.job.job_id, retry.job.job_id);
  await assert.rejects(
    bridge.startVerify(PREPARATION_JOB_ID, { ...args, changes: [{ path: "src/app.py", content: "different" }] }),
    (error) => error.code === "preparation_consumed",
  );
  assert.equal(mock.calls.filter((call) => call.url.pathname.endsWith("/dispatches")).length, 1);
});

test("rejects verify mismatches and does not consume preparation on a pre-dispatch quota failure", async () => {
  const mock = successfulFetch({ ok: false, status: "not-polled" }, { conclusion: "failure" });
  const bridge = bridgeWith(mock.fetchImpl, { maxStartsPerMinute: 1, maxStartsPerHour: 12 });
  seedPreparation(bridge);
  const args = {
    repo_url: "https://github.com/example/project",
    expected_commit: "b".repeat(40),
    expected_baseline_sha256: "c".repeat(64),
    changes: [{ path: "src/app.py", content: "fixed" }],
  };
  await assert.rejects(
    bridge.startVerify(PREPARATION_JOB_ID, { ...args, expected_commit: "d".repeat(40) }),
    (error) => error.code === "preparation_required",
  );
  bridge.starts = [FIXED_NOW];
  await assert.rejects(bridge.startVerify(PREPARATION_JOB_ID, args), (error) => error.code === "rate_limited");
  assert.equal(bridge.jobs.get(PREPARATION_JOB_ID).verificationConsumed, undefined);
  bridge.starts = [];
  const started = await bridge.startVerify(PREPARATION_JOB_ID, args);
  assert.equal(started.job.job_id, JOB_ID);
  assert.equal(bridge.jobs.get(PREPARATION_JOB_ID).verificationConsumed, true);
});

test("a consumed preparation does not block a fresh prepare for the same repository", async () => {
  const mock = successfulFetch({ ok: false, status: "not-polled" }, { conclusion: "failure" });
  const issued = ["V".repeat(43), "N".repeat(43)];
  const requests = ["X".repeat(43), "Y".repeat(43)];
  const bridge = bridgeWith(mock.fetchImpl, {
    idFactory: () => issued.shift(),
    requestIdFactory: () => requests.shift(),
    maxActive: 2,
  });
  const prepareArgs = { repo_url: "https://github.com/example/project" };
  seedPreparation(bridge, {
    payloadSha256: createHash("sha256").update(encodeDispatchPayload("prepare", prepareArgs)).digest("hex"),
  });
  await bridge.startVerify(PREPARATION_JOB_ID, {
    ...prepareArgs,
    expected_commit: "b".repeat(40),
    expected_baseline_sha256: "c".repeat(64),
    changes: [{ path: "src/app.py", content: "fixed" }],
  });
  const fresh = await bridge.start("prepare", prepareArgs);
  assert.equal(fresh.job.job_id, "N".repeat(43));
  assert.notEqual(fresh.job.job_id, PREPARATION_JOB_ID);
});

test("enforces the same 55 KB decoded payload boundary for compressible and multibyte data", () => {
  assert.doesNotThrow(() => encodeDispatchPayload("verify", { content: "😀".repeat(10_000) }));
  assert.throws(
    () => encodeDispatchPayload("verify", { content: "😀".repeat(14_000) }),
    (error) => error instanceof ActionsBridgeError && error.code === "payload_too_large",
  );
  assert.throws(
    () => encodeDispatchPayload("verify", { content: "x".repeat(55_000) }),
    (error) => error instanceof ActionsBridgeError && error.code === "payload_too_large",
  );
});

test("rejects a non-allow-listed repository before any GitHub HTTP request", async () => {
  let fetches = 0;
  const bridge = bridgeWith(async () => {
    fetches += 1;
    throw new Error("must not fetch");
  });
  await assert.rejects(
    bridge.start("prepare", { repo_url: "https://github.com/other/project.git" }),
    (error) => error.code === "repository_not_allowed",
  );
  assert.equal(fetches, 0);
  await assert.rejects(
    bridge.start("prepare", { repo_url: "https://github.com/EXAMPLE/PROJECT.git" }),
    (error) => error.code === "provider_unavailable",
  );
  assert.equal(fetches, 1, "case and .git normalization must reach the reviewed target only");
  assert.throws(
    () => new GitHubActionsBridge({
      token: "token",
      repository: REPOSITORY,
      workflow: "repo-rescue-actions-bridge.yml",
      ref: "main",
      allowedRepositories: ["valid/repo", "malformed"],
    }),
    (error) => error.code === "configuration_required",
  );
});

test("environment deployment fails closed unless the reviewed allow-list matches exactly", () => {
  const base = {
    REPO_RESCUE_GITHUB_TOKEN: "token",
    REPO_RESCUE_ACTIONS_REF: "main",
  };
  for (const configured of [
    "",
    "wenjieding327/repo-rescue-canary",
    "wenjieding327/repo-rescue-canary,wenjieding327/repo-rescue-mcp,other/repo",
    "malformed",
  ]) {
    assert.throws(
      () => GitHubActionsBridge.fromEnvironment({ ...base, REPO_RESCUE_ALLOWED_REPOS: configured }),
      (error) => error.code === "configuration_required",
    );
  }
  const bridge = GitHubActionsBridge.fromEnvironment({
    ...base,
    REPO_RESCUE_ALLOWED_REPOS: "wenjieding327/repo-rescue-mcp,wenjieding327/repo-rescue-canary",
  }, { fetchImpl: async () => { throw new Error("unused"); } });
  assert.equal(bridge.maxActive, 1);
});

test("enforces the rolling hourly dispatch budget before sending HTTP", async () => {
  let dispatches = 0;
  let ids = 0;
  const fetchImpl = async (url) => {
    const path = new URL(url).pathname;
    if (path.endsWith("/actions/workflows/repo-rescue-actions-bridge.yml")) {
      return jsonResponse({ id: WORKFLOW_ID, path: WORKFLOW_PATH, name: "bridge", state: "active" });
    }
    if (path.endsWith(`/actions/workflows/${WORKFLOW_ID}/dispatches`)) {
      dispatches += 1;
      return jsonResponse({ workflow_run_id: RUN_ID + dispatches });
    }
    throw new Error(`Unexpected request ${path}`);
  };
  const bridge = bridgeWith(fetchImpl, {
    idFactory: () => String.fromCharCode(65 + ids++).repeat(43),
    requestIdFactory: () => String.fromCharCode(75 + ids).repeat(43),
    maxActive: 2,
    maxStartsPerMinute: 60,
    maxStartsPerHour: 1,
    allowedRepositories: ["example/first", "example/second"],
  });
  const first = await bridge.start("prepare", { repo_url: "https://github.com/example/first" });
  bridge.jobs.get(first.job.job_id).terminal = true;
  await assert.rejects(
    bridge.start("prepare", { repo_url: "https://github.com/example/second" }),
    (error) => error.code === "rate_limited",
  );
  assert.equal(dispatches, 1);
});

test("never exposes the configured token in provider errors", async () => {
  const token = "test-secret-value-not-a-token";
  const bridge = new GitHubActionsBridge({
    token,
    repository: REPOSITORY,
    workflow: "repo-rescue-actions-bridge.yml",
    ref: "main",
    allowedRepositories: ["example/project"],
    fetchImpl: async () => { throw new Error(`socket closed with ${token}`); },
  });
  await assert.rejects(
    bridge.start("prepare", { repo_url: "https://github.com/example/project" }),
    (error) => !error.message.includes(token),
  );
});

test("bounds a stalled GitHub request with an abort signal", async () => {
  const bridge = bridgeWith(
    async (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
    }),
    { requestTimeoutMs: 50 },
  );
  const started = Date.now();
  await assert.rejects(
    bridge.start("prepare", { repo_url: "https://github.com/example/project" }),
    (error) => error.code === "provider_unavailable",
  );
  assert.ok(Date.now() - started < 1_000);
});

test("treats an interrupted JSON response body as retryable provider unavailability", async () => {
  const fetchImpl = async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"id":'));
      controller.error(new Error("stream reset"));
    },
  }), { status: 200 });
  const bridge = bridgeWith(fetchImpl);
  await assert.rejects(
    bridge.start("prepare", { repo_url: "https://github.com/example/project" }),
    (error) => error.code === "provider_unavailable",
  );
});

test("expires an abandoned active job so it cannot hold capacity forever", async () => {
  let now = FIXED_NOW;
  let dispatches = 0;
  let ids = 0;
  const fetchImpl = async (url) => {
    const path = new URL(url).pathname;
    if (path.endsWith("/actions/workflows/repo-rescue-actions-bridge.yml")) {
      return jsonResponse({ id: WORKFLOW_ID, path: WORKFLOW_PATH, name: "bridge", state: "active" });
    }
    if (path.endsWith(`/actions/workflows/${WORKFLOW_ID}/dispatches`)) {
      dispatches += 1;
      return jsonResponse({ workflow_run_id: RUN_ID + dispatches });
    }
    throw new Error(`Unexpected request ${path}`);
  };
  const bridge = bridgeWith(fetchImpl, {
    now: () => now,
    idFactory: () => String.fromCharCode(65 + ids++).repeat(43),
    requestIdFactory: () => String.fromCharCode(75 + ids).repeat(43),
    maxActive: 1,
    maxStartsPerMinute: 3,
    maxRunMs: 60_000,
    allowedRepositories: ["example/first", "example/second"],
  });
  const abandoned = await bridge.start("prepare", { repo_url: "https://github.com/example/first" });
  now += 61_000;
  const replacement = await bridge.start("prepare", { repo_url: "https://github.com/example/second" });
  assert.notEqual(abandoned.job.job_id, replacement.job.job_id);
  assert.equal(dispatches, 2);
  const old = await bridge.get(abandoned.job.job_id);
  assert.equal(old.job.terminal, true);
  assert.equal(old.job.result.status, "provider_timeout");
});

test("expires a legacy dispatch that never becomes discoverable", async () => {
  let now = FIXED_NOW;
  let dispatches = 0;
  let ids = 0;
  const fetchImpl = async (url) => {
    const path = new URL(url).pathname;
    if (path.endsWith("/actions/workflows/repo-rescue-actions-bridge.yml")) {
      return jsonResponse({ id: WORKFLOW_ID, path: WORKFLOW_PATH, name: "bridge", state: "active" });
    }
    if (path.endsWith(`/actions/workflows/${WORKFLOW_ID}/dispatches`)) {
      dispatches += 1;
      return new Response(null, { status: 204 });
    }
    if (path.endsWith(`/actions/workflows/${WORKFLOW_ID}/runs`)) return jsonResponse({ workflow_runs: [] });
    throw new Error(`Unexpected request ${path}`);
  };
  const bridge = bridgeWith(fetchImpl, {
    now: () => now,
    idFactory: () => String.fromCharCode(65 + ids++).repeat(43),
    requestIdFactory: () => String.fromCharCode(75 + ids).repeat(43),
    maxActive: 1,
    maxStartsPerMinute: 3,
    dispatchDiscoveryMs: 30_000,
    allowedRepositories: ["example/first", "example/second"],
  });
  const first = await bridge.start("prepare", { repo_url: "https://github.com/example/first" });
  await bridge.get(first.job.job_id);
  now += 31_000;
  const second = await bridge.start("prepare", { repo_url: "https://github.com/example/second" });
  assert.notEqual(first.job.job_id, second.job.job_id);
  assert.equal(dispatches, 2);
  const expired = await bridge.get(first.job.job_id);
  assert.equal(expired.job.result.status, "provider_timeout");
});

test("rejects duplicate result.json entries in a ZIP artifact", () => {
  const zip = storedZip({ "result.json": "{}", "nested/result.json": "{}" });
  assert.throws(() => extractBridgeArtifact(zip), /duplicate result\.json/i);
});
