import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { ActionsBridgeError, GitHubActionsBridge } from "../actions-bridge.mjs";

const REPOSITORY = "wenjieding327/repo-rescue-mcp";
const TARGET = "wenjieding327/repo-rescue-canary";
const ALLOW_LIST = [TARGET, REPOSITORY];
const WORKFLOW_PATH = ".github/workflows/repo-rescue-actions-bridge.yml";
const RUN_ID = 1234;
const ARTIFACT_ID = 5678;
const HEAD = "a".repeat(40);
const REQUEST = "R".repeat(43);
const NOW = Date.parse("2026-09-12T12:00:00Z");
const EXPIRES = new Date(NOW + 7 * 86_400_000).toISOString();
const TOKEN = "not-a-real-secret-artifact-loader-fixture";
const digest = (content) => createHash("sha256").update(content).digest("hex");

function integer(value, width) {
  const bytes = Buffer.alloc(width);
  bytes.writeUIntLE(value, 0, width);
  return bytes;
}

function storedZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [path, value] of Object.entries(entries)) {
    const name = Buffer.from(path);
    const body = Buffer.from(value);
    const local = Buffer.concat([
      integer(0x04034b50, 4), integer(20, 2), Buffer.alloc(12),
      integer(body.length, 4), integer(body.length, 4), integer(name.length, 2), integer(0, 2), name, body,
    ]);
    const central = Buffer.concat([
      integer(0x02014b50, 4), integer(20, 2), integer(20, 2), Buffer.alloc(12),
      integer(body.length, 4), integer(body.length, 4), integer(name.length, 2), Buffer.alloc(12), integer(offset, 4), name,
    ]);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const central = Buffer.concat(centrals);
  return Buffer.concat([...locals, central,
    integer(0x06054b50, 4), Buffer.alloc(4), integer(centrals.length, 2), integer(centrals.length, 2),
    integer(central.length, 4), integer(offset, 4), Buffer.alloc(2),
  ]);
}

function fixture({ mutateRun, mutateArtifact, mutateEnvelope, mutateEvidence, mutateFiles, privateSource = false, corruptZip = false, redirect = false } = {}) {
  const patch = Buffer.from("--- a/src/app.py\r\n+++ b/src/app.py\r\n@@ -1 +1 @@\r\n-broken\r\n+fixed\r\n");
  const baseline = {
    backend: "docker", command: "python -m pytest -q", verified: false,
    verification_scope: "pytest_suite", preparation_baseline_sha256: "c".repeat(64),
    execution: { exit_code: 1, timed_out: false, pytest_attestation: {
      completed: true, collected: 3, passed: 2, failed: 1, errors: 0, skipped: 0, runner_exit_code: 1,
    } },
  };
  const final = {
    backend: "docker", command: baseline.command, verified: true,
    verification_scope: "pytest_suite", repair_evidence_eligible: true,
    execution: { exit_code: 0, timed_out: false, pytest_attestation: {
      completed: true, collected: 3, passed: 3, failed: 0, errors: 0, skipped: 0, runner_exit_code: 0,
    } },
  };
  const repair = {
    run_id: "20260912T120000Z-abc12345", verified_repair: true, status: "verified_repair",
    repository: { slug: TARGET, url: `https://github.com/${TARGET}`, commit: "b".repeat(40) },
    verifier_backend: "docker", baseline, final_verification: final,
    patch_sha256: digest(patch), changed_files: ["src/app.py"],
  };
  repair.attestation_sha256 = digest(Buffer.from([repair.run_id, repair.repository.commit, baseline.command, 1, 0, repair.patch_sha256].join("|")));
  const envelope = {
    request_id: REQUEST, mode: "verify", github_run_id: String(RUN_ID), github_sha: HEAD,
    payload_sha256: "d".repeat(64), result: { ok: true, repair: { ...repair, artifacts: { available: ["patch", "evidence", "report"] } } },
  };
  mutateEnvelope?.(envelope);
  const evidence = structuredClone(envelope.result.repair);
  evidence.artifacts = { run_id: repair.run_id, available: ["patch", "evidence", "report"], retrieval_tool: "get_repair_artifact" };
  mutateEvidence?.(evidence);
  const files = {
    "result.json": Buffer.from(JSON.stringify(envelope)),
    "repair/repair.patch": patch,
    "repair/evidence.json": Buffer.from(JSON.stringify(evidence)),
    // The raw UTF-8 BOM and CRLF must survive a download unchanged.
    "repair/report.md": Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(`# Evidence\r\n${repair.run_id}\r\n<script>not executed</script>\r\n`)]),
  };
  mutateFiles?.(files);
  const zip = storedZip(files);
  const run = {
    id: RUN_ID, workflow_id: 42, event: "workflow_dispatch", run_attempt: 1,
    head_branch: "main", head_sha: HEAD, path: `${WORKFLOW_PATH}@refs/heads/main`,
    created_at: new Date(NOW - 120_000).toISOString(), status: "completed", conclusion: "success",
    display_title: `RepoRescue ${REQUEST} verify`, html_url: "https://untrusted.example/do-not-echo",
  };
  mutateRun?.(run);
  const artifact = {
    id: ARTIFACT_ID, name: `repo-rescue-${REQUEST}`, expired: false, expires_at: EXPIRES,
    size_in_bytes: zip.length, digest: `sha256:${digest(zip)}`, workflow_run: { id: RUN_ID, head_sha: HEAD },
  };
  mutateArtifact?.(artifact);
  const calls = [];
  const json = (value) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url);
    calls.push({ url: parsed.href, options });
    assert.equal(options.method, "GET", "Receipt must never dispatch or mutate GitHub state");
    if (parsed.origin === "https://signed.example") return new Response(zip);
    assert.equal(parsed.origin, "https://api.github.com");
    assert.equal(options.headers.Authorization, `Bearer ${TOKEN}`);
    const path = parsed.pathname;
    if (path === `/repos/${REPOSITORY}/actions/workflows/repo-rescue-actions-bridge.yml`) return json({ id: 42, path: WORKFLOW_PATH, state: "active" });
    if (path === `/repos/${REPOSITORY}/actions/runs/${RUN_ID}`) return json(run);
    if (path === `/repos/${REPOSITORY}/actions/runs/${RUN_ID}/artifacts`) return json({ artifacts: [artifact] });
    if (path === `/repos/${REPOSITORY}/actions/artifacts/${ARTIFACT_ID}/zip`) {
      if (redirect) return new Response(null, { status: 302, headers: { location: "https://signed.example/artifact" } });
      return new Response(corruptZip ? Buffer.concat([zip, Buffer.from("tampered")]) : zip);
    }
    if (path === `/repos/${TARGET}`) return json({ full_name: TARGET, private: privateSource });
    throw new Error("Unexpected fixture request");
  };
  const bridge = new GitHubActionsBridge({ token: TOKEN, allowedRepositories: ALLOW_LIST, now: () => NOW, fetchImpl });
  return { bridge, calls, files, zip, envelope, fetchImpl };
}

test("receipt loader returns original bytes, bound metadata, and needs no remembered job", async () => {
  const mock = fixture();
  const result = await mock.bridge.loadVerifiedArtifact({ runId: RUN_ID, artifactId: ARTIFACT_ID });
  assert.deepEqual(result.zip, mock.zip);
  assert.deepEqual(result.result, mock.envelope);
  for (const [name, content] of Object.entries(mock.files)) assert.deepEqual(result.files.get(name.split("/").at(-1)), content);
  assert.equal(result.expiresAt, EXPIRES);
  assert.equal(result.metadata.artifact_expires_at, EXPIRES);
  assert.equal(result.metadata.html_url, `https://github.com/${REPOSITORY}/actions/runs/${RUN_ID}`);
  assert.equal(result.metadata.files["report.md"].sha256, digest(mock.files["repair/report.md"]));
  assert.equal(mock.bridge.jobs.size, 0);
  assert.equal(mock.bridge.starts.length, 0);
  const restarted = new GitHubActionsBridge({ token: TOKEN, allowedRepositories: ALLOW_LIST, now: () => NOW, fetchImpl: mock.fetchImpl });
  assert.deepEqual((await restarted.loadVerifiedArtifact({ runId: RUN_ID, artifactId: ARTIFACT_ID })).files, result.files);
});

test("receipt identifiers and non-reviewed bridge configuration are rejected before network", async () => {
  for (const ids of [{ runId: "1234", artifactId: ARTIFACT_ID }, { runId: RUN_ID, artifactId: -1 }, { runId: Number.MAX_SAFE_INTEGER + 1, artifactId: ARTIFACT_ID }]) {
    const mock = fixture();
    await assert.rejects(mock.bridge.loadVerifiedArtifact(ids), { code: "invalid_request" });
    assert.equal(mock.calls.length, 0);
  }
  for (const [key, value] of [["repository", "example/repo"], ["workflow", "other.yml"], ["ref", "dev"], ["allowedRepositories", new Set([TARGET])]]) {
    const mock = fixture();
    mock.bridge[key] = value;
    await assert.rejects(mock.bridge.loadVerifiedArtifact({ runId: RUN_ID, artifactId: ARTIFACT_ID }), { code: "configuration_required" });
    assert.equal(mock.calls.length, 0);
  }
});

test("receipt rejects mismatched run/workflow/head/branch/attempt and incomplete runs", async () => {
  for (const changed of [
    { id: RUN_ID + 1 }, { workflow_id: 43 }, { event: "push" }, { run_attempt: 2 }, { head_branch: "dev" },
    { head_sha: "bad" }, { path: ".github/workflows/evil.yml" }, { status: "queued" }, { conclusion: "failure" },
    { display_title: `RepoRescue ${REQUEST} prepare` }, { display_title: "unrelated" }, { created_at: new Date(NOW + 120_000).toISOString() },
  ]) {
    const mock = fixture({ mutateRun: (run) => Object.assign(run, changed) });
    await assert.rejects(mock.bridge.loadVerifiedArtifact({ runId: RUN_ID, artifactId: ARTIFACT_ID }), ActionsBridgeError);
    assert.equal(mock.calls.some((call) => call.url.endsWith("/zip")), false);
  }
});

test("receipt rejects expired, wrong-ID, cross-run, cross-head, and digest-free artifacts", async () => {
  for (const changed of [
    { id: ARTIFACT_ID + 1 }, { expired: true }, { expires_at: new Date(NOW - 1).toISOString() }, { expires_at: "invalid" },
    { name: `repo-rescue-${"Z".repeat(43)}` }, { workflow_run: { id: RUN_ID + 1, head_sha: HEAD } },
    { workflow_run: { id: RUN_ID, head_sha: "b".repeat(40) } }, { digest: "" }, { size_in_bytes: 0 },
  ]) {
    const mock = fixture({ mutateArtifact: (artifact) => Object.assign(artifact, changed) });
    await assert.rejects(mock.bridge.loadVerifiedArtifact({ runId: RUN_ID, artifactId: ARTIFACT_ID }), ActionsBridgeError);
    assert.equal(mock.calls.some((call) => call.url.endsWith("/zip")), false);
  }
});

test("receipt rejects changed ZIPs, missing evidence, unexpected entries and patch tampering", async () => {
  const variants = [
    { corruptZip: true },
    { mutateFiles: (files) => { delete files["repair/report.md"]; } },
    { mutateFiles: (files) => { files["unrelated.txt"] = Buffer.from("not a permitted delivery"); } },
    { mutateFiles: (files) => { files["repair/repair.patch"] = Buffer.from("changed patch"); } },
    { mutateFiles: (files) => { files["repair/evidence.json"] = Buffer.from("invalid JSON"); } },
    { mutateFiles: (files) => { files["repair/report.md"] = Buffer.from([0xff]); } },
  ];
  for (const variant of variants) {
    const mock = fixture(variant);
    await assert.rejects(mock.bridge.loadVerifiedArtifact({ runId: RUN_ID, artifactId: ARTIFACT_ID }), { code: "artifact_invalid" });
  }
});

test("receipt binds envelope nonce, payload hash, mode, run and bridge head", async () => {
  for (const changed of [
    { request_id: "Z".repeat(43) }, { payload_sha256: "not a hash" }, { mode: "prepare" },
    { github_run_id: String(RUN_ID + 1) }, { github_sha: "b".repeat(40) },
  ]) {
    const mock = fixture({ mutateEnvelope: (envelope) => Object.assign(envelope, changed) });
    await assert.rejects(mock.bridge.loadVerifiedArtifact({ runId: RUN_ID, artifactId: ARTIFACT_ID }), { code: "artifact_invalid" });
  }
});

test("receipt refuses false verdict, bad repository, execution, test-scope and attestation claims", async () => {
  const mutations = [
    (repair) => { repair.verified_repair = false; },
    (repair) => { repair.repository.slug = "example/private"; },
    (repair) => { repair.repository.commit = "short"; },
    (repair) => { repair.repository.url = "https://untrusted.example"; },
    (repair) => { repair.verifier_backend = "local"; },
    (repair) => { repair.baseline.verified = true; },
    (repair) => { repair.final_verification.command = "echo success"; },
    (repair) => { repair.final_verification.execution.exit_code = 1; },
    (repair) => { repair.final_verification.execution.timed_out = true; },
    (repair) => { repair.final_verification.repair_evidence_eligible = false; },
    (repair) => { repair.final_verification.execution.pytest_attestation.collected = 1; },
    (repair) => { repair.final_verification.execution.pytest_attestation.completed = false; },
    (repair) => { repair.attestation_sha256 = "e".repeat(64); },
  ];
  for (const mutate of mutations) {
    const mock = fixture({ mutateEnvelope: (envelope) => mutate(envelope.result.repair) });
    await assert.rejects(mock.bridge.loadVerifiedArtifact({ runId: RUN_ID, artifactId: ARTIFACT_ID }), { code: "artifact_invalid" });
  }
});

test("receipt requires full evidence equality, not merely identical headline fields", async () => {
  const mock = fixture({ mutateEvidence: (evidence) => { evidence.changed_files = ["other.py"]; } });
  await assert.rejects(mock.bridge.loadVerifiedArtifact({ runId: RUN_ID, artifactId: ARTIFACT_ID }), { code: "artifact_invalid" });
});

test("receipt rejects a different run in the evidence transport descriptor", async () => {
  const mock = fixture({ mutateEvidence: (evidence) => { evidence.artifacts.run_id = "other-run"; } });
  await assert.rejects(mock.bridge.loadVerifiedArtifact({ runId: RUN_ID, artifactId: ARTIFACT_ID }), { code: "artifact_invalid" });
});

test("receipt refuses a reviewed source repository that has become private", async () => {
  const mock = fixture({ privateSource: true });
  await assert.rejects(mock.bridge.loadVerifiedArtifact({ runId: RUN_ID, artifactId: ARTIFACT_ID }), { code: "artifact_unavailable" });
});

test("receipt refuses credentials in artifacts without exposing their value", async () => {
  for (const secret of [TOKEN, `github_pat_${"X".repeat(30)}`, "Bearer nonpublic-value"]) {
    const mock = fixture({ mutateFiles: (files) => { files["repair/report.md"] = Buffer.concat([files["repair/report.md"], Buffer.from(secret)]); } });
    await assert.rejects(mock.bridge.loadVerifiedArtifact({ runId: RUN_ID, artifactId: ARTIFACT_ID }), (error) => {
      assert.equal(error.code, "artifact_invalid");
      assert.equal(error.message.includes(secret), false);
      return true;
    });
  }
});

test("receipt signed download redirect never forwards GitHub authentication", async () => {
  const mock = fixture({ redirect: true });
  await mock.bridge.loadVerifiedArtifact({ runId: RUN_ID, artifactId: ARTIFACT_ID });
  const redirected = mock.calls.find((call) => call.url.startsWith("https://signed.example"));
  assert.equal(redirected.options.headers.Authorization, undefined);
  assert.equal(redirected.options.redirect, "error");
});
