import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";
import { createArtifactReceipts } from "../artifact-receipts.mjs";

const NOW = Date.parse("2026-09-12T08:00:00.000Z");
const KEY = "receipt-test-key-not-a-real-credential-1234567890";
const ORIGIN = "https://receipts.example.test";
const REPOSITORY = "wenjieding327/repo-rescue-mcp";
const NAMES = ["repair.patch", "evidence.json", "report.md", "result.json"];
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

function fixture({ runId = 34450708989, artifactId = 77221, expiresAt = NOW + 86_400_000,
  patch = Buffer.from("\uFEFF--- a/src/example.py\r\n+++ b/src/example.py\r\n@@ -1 +1 @@\r\n-print('坏')\r\n+print('好')\r\n", "utf8"),
  report = Buffer.from("# 原始报告\r\n\r\n保留缩进：\r\n    hello\r\n", "utf8"),
} = {}) {
  const counts = (passed, failed) => ({ completed: true, collected: 3, passed, failed, errors: 0, skipped: 0 });
  const repair = {
    run_id: "20260912T080000Z-01234567", status: "verified_repair", verified_repair: true,
    repository: { slug: "wenjieding327/repo-rescue-canary", commit: "a".repeat(40) },
    patch_sha256: sha(patch),
    baseline: { command: "python -m pytest -q", execution: { stdout: "1 failed, 2 passed\n", pytest_attestation: counts(2, 1) } },
    final_verification: { command: "python -m pytest -q", execution: { stdout: "3 passed\n", pytest_attestation: counts(3, 0) } },
  };
  const result = { request_id: "R".repeat(43), mode: "verify", payload_sha256: "b".repeat(64),
    github_run_id: String(runId), github_sha: "c".repeat(40), result: { ok: true, repair } };
  const files = new Map([
    ["repair.patch", Buffer.from(patch)], ["evidence.json", Buffer.from(JSON.stringify(repair, null, 2) + "\n")],
    ["report.md", Buffer.from(report)], ["result.json", Buffer.from(JSON.stringify(result, null, 2) + "\r\n")],
  ]);
  // The loader is mocked here: its own suite checks ZIP extraction and GitHub
  // attestation. This suite verifies exact delivery of its already-validated bytes.
  const zip = Buffer.concat([Buffer.from([0x50, 0x4b, 3, 4, 0, 255]), ...files.values()]);
  const expiry = new Date(expiresAt).toISOString();
  const metadata = {
    repository: REPOSITORY, workflow_run_id: runId, artifact_id: artifactId, head_sha: result.github_sha,
    artifact_name: `repo-rescue-${"R".repeat(43)}`, artifact_digest: `sha256:${sha(zip)}`,
    artifact_expires_at: expiry, html_url: `https://github.com/${REPOSITORY}/actions/runs/${runId}`,
    files: Object.fromEntries([...files].map(([name, bytes]) => [name, { bytes: bytes.length, sha256: sha(bytes) }])),
  };
  return { files, zip, result, expiresAt: expiry, metadata };
}

function toolResult(bundle) { return { ...bundle.result.result, github_actions: bundle.metadata }; }
function service(bundle = fixture(), options = {}) {
  return createArtifactReceipts({ signingKey: KEY, publicOrigin: ORIGIN, now: () => NOW,
    loadArtifact: async () => bundle, ...options });
}
function pathOf(url) { return new URL(url).pathname; }
async function request(receipts, url, { method = "GET", headers = {} } = {}) {
  const response = { status: null, headers: null, bytes: null, destroyed: false, writableEnded: false,
    writeHead(status, values) { this.status = status; this.headers = values; },
    end(bytes) { this.bytes = bytes === undefined ? Buffer.alloc(0) : Buffer.from(bytes); this.writableEnded = true; },
  };
  const handled = await receipts.handle({ url, method, headers }, response);
  return { ...response, handled, text: response.bytes?.toString("utf8") || "" };
}
function refreshFileMetadata(bundle, name) {
  const bytes = bundle.files.get(name);
  bundle.metadata.files[name] = { bytes: bytes.length, sha256: sha(bytes) };
}
function refreshResult(bundle) {
  bundle.files.set("result.json", Buffer.from(JSON.stringify(bundle.result)));
  refreshFileMetadata(bundle, "result.json");
}

test("receipt configuration rejects unsafe origins and invalid signing keys", () => {
  for (const publicOrigin of ["http://example.test", "https://user:password@example.test", "https://example.test/path", "https://example.test/?x=1", "https://example.test/#fragment", "invalid"]) {
    assert.throws(() => service(undefined, { publicOrigin }), /fixed HTTPS origin/);
  }
  for (const signingKey of [undefined, "", "x".repeat(31), "x".repeat(513)]) {
    assert.throws(() => service(undefined, { signingKey }), /32 to 512 bytes/);
  }
  assert.throws(() => service(undefined, { loadArtifact: null }), /loader and clock/);
  assert.throws(() => service(undefined, { now: null }), /loader and clock/);
  assert.doesNotThrow(() => service(undefined, { signingKey: Buffer.from(KEY), publicOrigin: `${ORIGIN}/` }));
});

test("mint signs only bound verified results, without provider URLs or private job capabilities", () => {
  const bundle = fixture();
  const receipts = service(bundle);
  const result = toolResult(bundle);
  result.job_id = "private-job-should-never-be-in-a-link";
  result.github_actions.html_url = "https://evil.example/";
  const url = receipts.mint(result);
  assert.match(url, /^https:\/\/receipts\.example\.test\/r\/v1\.34450708989\.77221\.\d{10}\.[A-Za-z0-9_-]{32}$/);
  assert.equal(receipts.mint(result), url);
  assert.doesNotMatch(url, /private-job|evil\.example|receipt-test-key/);
  const invalid = [
    (value) => { value.ok = false; },
    (value) => { value.repair.verified_repair = false; },
    (value) => { value.repair.status = "candidate_runs"; },
    (value) => { value.repair.repository.slug = "example/not-allowed"; },
    (value) => { value.repair.repository.commit = "not-a-sha"; },
    (value) => { value.github_actions.repository = "example/private"; },
    (value) => { value.github_actions.workflow_run_id = Number.MAX_SAFE_INTEGER + 1; },
    (value) => { value.github_actions.artifact_id = 0; },
    (value) => { value.github_actions.head_sha = "x"; },
    (value) => { value.github_actions.artifact_digest = "sha256:bad"; },
    (value) => { value.github_actions.artifact_name = "unbound"; },
    (value) => { delete value.github_actions.files["report.md"]; },
    (value) => { value.github_actions.files["repair.patch"].sha256 = "0".repeat(64); },
    (value) => { value.github_actions.files["report.md"].bytes = 4 * 1024 * 1024 + 1; },
    (value) => { value.github_actions.artifact_expires_at = null; },
    (value) => { value.github_actions.artifact_expires_at = "tomorrow"; },
    (value) => { value.github_actions.artifact_expires_at = new Date(NOW - 1).toISOString(); },
  ];
  for (const mutate of invalid) {
    const candidate = structuredClone(result); mutate(candidate);
    assert.equal(receipts.mint(candidate), "", String(mutate));
  }
  for (const value of [null, {}, [], { ok: true }, { repair: {} }]) assert.equal(receipts.mint(value), "");
});

test("receipt expiry is capped at seven days and never exceeds artifact expiry", async () => {
  for (const duration of [60_500, 86_400_000, 20 * 86_400_000]) {
    const bundle = fixture({ expiresAt: NOW + duration });
    const receipts = service(bundle);
    const url = receipts.mint(toolResult(bundle));
    const expiry = Number(pathOf(url).split(".")[3]) * 1000;
    assert.ok(expiry <= NOW + 7 * 86_400_000);
    assert.ok(expiry <= Date.parse(bundle.expiresAt));
    const page = await request(receipts, pathOf(url));
    assert.equal(page.status, 200);
    assert.ok(page.text.includes(new Date(expiry).toISOString()));
    assert.match(page.text, /持有链接即可读取/);
  }
});

test("same signing key restores a receipt after restart; another key cannot read it", async () => {
  const bundle = fixture();
  const first = service(bundle);
  const url = first.mint(toolResult(bundle));
  first.close();
  const restarted = service(bundle);
  assert.equal((await request(restarted, pathOf(url))).status, 200);
  let loads = 0;
  const rotated = service(bundle, { signingKey: "other-signing-key".repeat(3), loadArtifact: async () => { loads += 1; return bundle; } });
  assert.equal((await request(rotated, pathOf(url))).status, 404);
  assert.equal(loads, 0);
});

test("all signature and ID tampering is refused before calling the artifact loader", async () => {
  const bundle = fixture(); let loads = 0;
  const receipts = service(bundle, { loadArtifact: async () => { loads += 1; return bundle; } });
  const path = pathOf(receipts.mint(toolResult(bundle)));
  const parts = path.split(".");
  const modified = [
    path.replace("34450708989", "34450708990"), path.replace("77221", "77222"),
    path.replace(parts[3], String(Number(parts[3]) + 1)),
    path.slice(0, -1) + (path.endsWith("A") ? "B" : "A"),
    path.replace("v1", "v2"), path.replace("34450708989", "9007199254740992"),
    path.replace("34450708989", "034450708989"),
  ];
  for (const candidate of modified) assert.equal((await request(receipts, candidate)).status, 404);
  assert.equal(loads, 0);
});

test("expiry is checked before loading and before responding to a slow load", async () => {
  const bundle = fixture({ expiresAt: NOW + 60_000 }); let clock = NOW; let loads = 0;
  const receipts = service(bundle, { now: () => clock, loadArtifact: async () => { loads += 1; return bundle; } });
  const path = pathOf(receipts.mint(toolResult(bundle)));
  clock += 60_000;
  assert.equal((await request(receipts, path)).status, 410);
  assert.equal(loads, 0);
  clock = NOW;
  const slow = service(bundle, { now: () => clock, loadArtifact: async () => { clock = NOW + 60_000; return bundle; } });
  assert.equal((await request(slow, path)).status, 503);
});

test("valid signature beyond the seven-day horizon is rejected without loading", async () => {
  let loads = 0;
  const receiptKey = createHmac("sha256", KEY).update("RepoRescue/read-only-artifact-receipts/key/v1\0").digest();
  const payload = `v1.34450708989.77221.${Math.floor((NOW + 8 * 86_400_000) / 1000)}`;
  const signature = createHmac("sha256", receiptKey).update(payload).digest().subarray(0, 24).toString("base64url");
  const receipts = service(undefined, { loadArtifact: async () => { loads += 1; return fixture(); } });
  assert.equal((await request(receipts, `/r/${payload}.${signature}`)).status, 410);
  assert.equal(loads, 0);
});

test("only fixed read routes are handled, without query/path traversal or execution methods", async () => {
  const bundle = fixture(); let loads = 0;
  const receipts = service(bundle, { loadArtifact: async () => { loads += 1; return bundle; } });
  const path = pathOf(receipts.mint(toolResult(bundle)));
  for (const url of ["/healthz", "/api/tools/get_repair_job", "/sse", "/messages", "/random"]) {
    const response = await request(receipts, url); assert.equal(response.handled, false); assert.equal(response.status, null);
  }
  for (const suffix of ["/secret.txt", "/../package.json", "/%2e%2e/secret", "/repair.patch/other", "?download=secret", "/repair.patch?token=x", "#ignored", "/%72epair.patch", "//report.md"]) {
    assert.equal((await request(receipts, path + suffix)).status, 404, suffix);
  }
  for (const method of ["POST", "PUT", "DELETE", "OPTIONS"]) {
    const response = await request(receipts, path, { method }); assert.equal(response.status, 405); assert.equal(response.headers.Allow, "GET, HEAD");
  }
  assert.equal(loads, 0);
});

test("original file and ZIP downloads retain all bytes, SHA, BOM, indentation and CRLF", async () => {
  const bundle = fixture(); const receipts = service(bundle);
  const path = pathOf(receipts.mint(toolResult(bundle)));
  for (const name of [...NAMES, "artifacts.zip"]) {
    const response = await request(receipts, `${path}/${name}`);
    const expected = name === "artifacts.zip" ? bundle.zip : bundle.files.get(name);
    assert.equal(response.status, 200); assert.deepEqual(response.bytes, expected);
    assert.equal(sha(response.bytes), sha(expected)); assert.equal(Number(response.headers["Content-Length"]), expected.length);
    assert.match(response.headers["Content-Disposition"], /^attachment; filename="[a-z.-]+"$/);
    assert.equal(response.headers["Content-Type"], name === "artifacts.zip" ? "application/zip" : "application/octet-stream");
  }
  const patch = await request(receipts, `${path}/repair.patch`);
  assert.deepEqual([...patch.bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  const head = await request(receipts, `${path}/repair.patch`, { method: "HEAD" });
  assert.equal(head.status, 200); assert.equal(head.bytes.length, 0);
  assert.equal(head.headers["Content-Length"], patch.headers["Content-Length"]);
});

test("receipt HTML uses exact server hashes, escaped data, fixed links and security headers", async () => {
  const malicious = "</pre><script>alert('XSS')</script><img src=x onerror=alert(1)> [evil](javascript:alert(1))";
  const bundle = fixture({ patch: Buffer.from(malicious), report: Buffer.from(malicious) });
  bundle.result.result.repair.final_verification.command = malicious;
  bundle.result.result.repair.baseline.execution.stdout = malicious;
  refreshResult(bundle);
  bundle.metadata.html_url = "javascript:alert(1)";
  const receipts = service(bundle); const path = pathOf(receipts.mint(toolResult(bundle)));
  const response = await request(receipts, path, { headers: { host: "evil.example", "x-forwarded-host": "evil.example", origin: "https://evil.example" } });
  assert.equal(response.status, 200); assert.match(response.text, /2 通过 \/ 1 失败/); assert.match(response.text, /3 通过 \/ 0 失败/);
  assert.match(response.text, /&lt;script&gt;/); assert.doesNotMatch(response.text, /<script|<img|href="javascript:|evil\.example/);
  for (const bytes of bundle.files.values()) assert.ok(response.text.includes(sha(bytes)));
  assert.ok(response.text.includes(`https://github.com/${REPOSITORY}/actions/runs/34450708989`));
  assert.equal(response.headers["Referrer-Policy"], "no-referrer");
  assert.equal(response.headers["X-Content-Type-Options"], "nosniff");
  assert.match(response.headers["Cache-Control"], /no-store/);
  assert.match(response.headers["X-Robots-Tag"], /noindex/);
  assert.match(response.headers["Content-Security-Policy"], /script-src 'none'/);
  assert.equal(response.headers["Access-Control-Allow-Origin"], undefined);
});

test("large preview is clearly truncated but the original download is complete", async () => {
  const report = Buffer.from("<".repeat(70_000)); const bundle = fixture({ report });
  const receipts = service(bundle); const path = pathOf(receipts.mint(toolResult(bundle)));
  const response = await request(receipts, path);
  assert.equal(response.status, 200); assert.match(response.text, /预览已截断/); assert.ok(response.bytes.length < 200_000);
  assert.deepEqual((await request(receipts, `${path}/report.md`)).bytes, report);
});

test("missing test counts are explicitly unavailable, never fabricated", async () => {
  const bundle = fixture(); delete bundle.result.result.repair.baseline.execution.pytest_attestation;
  bundle.result.result.repair.final_verification.execution.pytest_attestation.passed = -1;
  refreshResult(bundle);
  const receipts = service(bundle);
  const response = await request(receipts, pathOf(receipts.mint(toolResult(bundle))));
  assert.equal(response.status, 200); assert.equal(response.text.match(/未提供完整测试数量/g)?.length, 2);
  assert.doesNotMatch(response.text, /-1 通过/);
});

test("download bundle cross-run, corrupt, expired and oversized responses fail closed", async () => {
  const mutations = [
    (bundle) => { bundle.metadata.workflow_run_id += 1; },
    (bundle) => { bundle.metadata.artifact_id += 1; },
    (bundle) => { bundle.result.github_run_id = "123"; },
    (bundle) => { bundle.result.github_sha = "d".repeat(40); },
    (bundle) => { bundle.result.mode = "prepare"; },
    (bundle) => { bundle.result.result.repair.verified_repair = false; },
    (bundle) => { bundle.result.result.repair.repository.slug = "example/private"; },
    (bundle) => { bundle.files.delete("report.md"); },
    (bundle) => { bundle.files.set("private.env", Buffer.from("private")); },
    (bundle) => { bundle.files.set("repair.patch", Buffer.from("different")); },
    (bundle) => { bundle.files.set("report.md", Buffer.alloc(4 * 1024 * 1024 + 1)); },
    (bundle) => { bundle.zip = Buffer.from("wrong zip"); },
    (bundle) => { bundle.zip = Buffer.alloc(8 * 1024 * 1024 + 1); },
    (bundle) => { bundle.metadata.artifact_digest = "sha256:" + "0".repeat(64); },
    (bundle) => { bundle.expiresAt = new Date(NOW - 1).toISOString(); },
    (bundle) => { bundle.expiresAt = new Date(NOW + 5000).toISOString(); },
    (bundle) => { bundle.files.set("result.json", Buffer.from("not JSON")); refreshFileMetadata(bundle, "result.json"); },
    (bundle) => { bundle.result.result.repair.issue = "not in the original bytes"; },
  ];
  for (const mutate of mutations) {
    const original = fixture(); const changed = fixture(); mutate(changed);
    const receipts = service(original, { loadArtifact: async () => changed });
    const response = await request(receipts, pathOf(receipts.mint(toolResult(original))));
    assert.equal(response.status, 503, String(mutate));
    assert.doesNotMatch(response.text, /private\.env|not JSON|wrong zip|verified_repair|gitbub_pat_|Bearer/);
  }
});

test("provider errors cannot expose credentials, signed storage URLs or private capability strings", async () => {
  const bundle = fixture();
  const receipts = service(bundle, { loadArtifact: async () => { throw new Error("Bearer private-secret github_pat_fake https://blob.example?sig=private job_id=private"); } });
  const response = await request(receipts, pathOf(receipts.mint(toolResult(bundle))));
  assert.equal(response.status, 503); assert.equal(response.headers["Retry-After"], "30");
  assert.doesNotMatch(response.text, /private|github_pat|blob\.example|job_id|Bearer/);
});

test("cache deduplicates reads, isolates loader buffer mutations and revalidates after five minutes", async () => {
  const bundle = fixture(); let loads = 0; let clock = NOW;
  const receipts = service(bundle, { now: () => clock, loadArtifact: async () => { loads += 1; return loads === 1 ? bundle : fixture(); } });
  const path = pathOf(receipts.mint(toolResult(bundle)));
  const first = await request(receipts, `${path}/repair.patch`);
  bundle.files.get("repair.patch").fill(0); bundle.zip.fill(0);
  const second = await request(receipts, `${path}/repair.patch`);
  assert.deepEqual(second.bytes, first.bytes); assert.equal(loads, 1);
  clock += 5 * 60_000;
  assert.equal((await request(receipts, `${path}/repair.patch`)).status, 200); assert.equal(loads, 2);
});

test("concurrent reads of one artifact share a load; a third distinct load is refused", async () => {
  const bundles = [fixture(), fixture({ runId: 34450708990, artifactId: 77222 }), fixture({ runId: 34450708991, artifactId: 77223 })];
  const releases = new Map(); const calls = [];
  const receipts = service(bundles[0], { loadArtifact: ({ runId }) => {
    calls.push(runId); return new Promise((resolve) => releases.set(runId, resolve));
  } });
  const paths = bundles.map((bundle) => pathOf(receipts.mint(toolResult(bundle))));
  const one = request(receipts, paths[0]); const duplicate = request(receipts, paths[0] + "/repair.patch");
  const two = request(receipts, paths[1]);
  await Promise.resolve(); await Promise.resolve();
  const three = await request(receipts, paths[2]);
  assert.equal(three.status, 429); assert.equal(three.headers["Retry-After"], "5");
  assert.deepEqual(calls, [34450708989, 34450708990]);
  releases.get(34450708989)(bundles[0]); releases.get(34450708990)(bundles[1]);
  assert.deepEqual((await Promise.all([one, duplicate, two])).map((value) => value.status), [200, 200, 200]);
});

test("global request rate is bounded without loading invalid links and resets after one minute", async () => {
  let clock = NOW; let loads = 0;
  const receipts = service(undefined, { now: () => clock, loadArtifact: async () => { loads += 1; return fixture(); } });
  for (let index = 0; index < 120; index += 1) assert.equal((await request(receipts, "/r/invalid")).status, 404);
  assert.equal((await request(receipts, "/r/invalid")).status, 429); assert.equal(loads, 0);
  clock += 60_000;
  assert.equal((await request(receipts, "/r/invalid")).status, 404);
});

test("cache entry count is bounded and evicts least recently used artifacts", async () => {
  const calls = new Map();
  const receipts = service(undefined, { loadArtifact: async ({ runId, artifactId }) => {
    calls.set(runId, (calls.get(runId) || 0) + 1); return fixture({ runId, artifactId });
  } });
  const paths = [];
  for (let index = 0; index < 17; index += 1) {
    const bundle = fixture({ runId: 1000 + index, artifactId: 2000 + index });
    paths.push(pathOf(receipts.mint(toolResult(bundle))));
    assert.equal((await request(receipts, paths[index])).status, 200);
  }
  assert.equal((await request(receipts, paths[1])).status, 200); assert.equal(calls.get(1001), 1);
  assert.equal((await request(receipts, paths[0])).status, 200); assert.equal(calls.get(1000), 2);
});

test("cache raw-byte budget evicts large artifacts before the entry-count limit", async () => {
  const report = Buffer.alloc(3 * 1024 * 1024, 0x61); const calls = new Map();
  const receipts = service(undefined, { loadArtifact: async ({ runId, artifactId }) => {
    calls.set(runId, (calls.get(runId) || 0) + 1); return fixture({ runId, artifactId, report });
  } });
  const paths = [];
  for (let index = 0; index < 6; index += 1) {
    const bundle = fixture({ runId: 1000 + index, artifactId: 2000 + index, report });
    paths.push(pathOf(receipts.mint(toolResult(bundle))));
    assert.equal((await request(receipts, paths[index] + "/report.md", { method: "HEAD" })).status, 200);
  }
  assert.equal((await request(receipts, paths[0] + "/report.md", { method: "HEAD" })).status, 200);
  assert.equal(calls.get(1000), 2, "Six roughly 6-MiB bundles cannot all remain in the 32-MiB cache");
});

test("expanded aggregate byte limits reject bundles even when each file is individually bounded", async () => {
  const valid = fixture(); const tooLarge = fixture();
  for (const name of NAMES) { tooLarge.files.set(name, Buffer.alloc(3 * 1024 * 1024, 0x61)); refreshFileMetadata(tooLarge, name); }
  const receipts = service(valid, { loadArtifact: async () => tooLarge });
  assert.equal((await request(receipts, pathOf(receipts.mint(toolResult(valid))))).status, 503);
});

test("failed artifact loads are not cached and release capacity for a safe retry", async () => {
  const bundle = fixture(); let loads = 0;
  const receipts = service(bundle, { loadArtifact: async () => {
    loads += 1; if (loads === 1) throw new Error("Provider temporarily unavailable"); return bundle;
  } });
  const path = pathOf(receipts.mint(toolResult(bundle)));
  assert.equal((await request(receipts, path)).status, 503);
  assert.equal((await request(receipts, path)).status, 200);
  assert.equal((await request(receipts, path)).status, 200);
  assert.equal(loads, 2);
});

test("closing disables mint and serving, including loads completing after close", async () => {
  const bundle = fixture(); let resolve;
  const receipts = service(bundle, { loadArtifact: () => new Promise((done) => { resolve = done; }) });
  const path = pathOf(receipts.mint(toolResult(bundle)));
  const pending = request(receipts, path);
  await Promise.resolve(); await Promise.resolve();
  receipts.close(); resolve(bundle);
  assert.equal((await pending).status, 503); assert.equal(receipts.mint(toolResult(bundle)), "");
  assert.equal((await request(receipts, path)).status, 503);
});

test("real HTTP transport returns original binary attachments and bodyless HEAD", async (t) => {
  const bundle = fixture(); const receipts = service(bundle);
  const server = createServer(async (req, res) => { if (!await receipts.handle(req, res)) { res.writeHead(404); res.end(); } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { receipts.close(); await new Promise((resolve) => server.close(resolve)); });
  const path = pathOf(receipts.mint(toolResult(bundle)));
  const url = `http://127.0.0.1:${server.address().port}${path}/repair.patch`;
  const downloaded = await fetch(url);
  assert.equal(downloaded.status, 200); assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), bundle.files.get("repair.patch"));
  const head = await fetch(url, { method: "HEAD" });
  assert.equal(head.status, 200); assert.equal((await head.arrayBuffer()).byteLength, 0);
  assert.equal(Number(head.headers.get("content-length")), bundle.files.get("repair.patch").length);
});
