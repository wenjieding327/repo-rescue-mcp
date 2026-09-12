import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { auditReceiptDownload } from "../scripts/audit-receipt-download.mjs";

const ORIGIN = "https://reporescue-mcp-production.up.railway.app";
const NOW = Date.parse("2026-09-12T12:00:00Z");
const URL = `${ORIGIN}/r/v1.1234.5678.${Math.floor((NOW + 86_400_000) / 1000)}.${"s".repeat(32)}`;
const TARGET = "wenjieding327/repo-rescue-canary";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function uint(value, width) { const buffer = Buffer.alloc(width); buffer.writeUIntLE(value, 0, width); return buffer; }
function zipFiles(files) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const [name, bytes] of files) {
    const filename = Buffer.from(name);
    const local = Buffer.concat([uint(0x04034b50, 4), uint(20, 2), Buffer.alloc(12), uint(bytes.length, 4), uint(bytes.length, 4), uint(filename.length, 2), uint(0, 2), filename, bytes]);
    const central = Buffer.concat([uint(0x02014b50, 4), uint(20, 2), uint(20, 2), Buffer.alloc(12), uint(bytes.length, 4), uint(bytes.length, 4), uint(filename.length, 2), Buffer.alloc(12), uint(offset, 4), filename]);
    locals.push(local); centrals.push(central); offset += local.length;
  }
  const central = Buffer.concat(centrals);
  return Buffer.concat([...locals, central, uint(0x06054b50, 4), Buffer.alloc(4), uint(centrals.length, 2), uint(centrals.length, 2), uint(central.length, 4), uint(offset, 4), Buffer.alloc(2)]);
}

async function outputFor(t) {
  const root = await mkdtemp(join(tmpdir(), "reporescue-receipt-audit-test-"));
  t.after(async () => {
    const checked = resolve(root);
    assert.equal(dirname(checked), resolve(tmpdir()));
    assert.match(basename(checked), /^reporescue-receipt-audit-test-[A-Za-z0-9_-]+$/);
    await rm(checked, { recursive: true, force: true });
  });
  return { root, out: join(root, "verified-downloads") };
}

function fixture({ mutateEnvelope, mutateEvidence, mutateZipFiles, mutateDownload, changeResponse } = {}) {
  const patch = Buffer.from("--- a/src/app.py\r\n+++ b/src/app.py\r\n@@ -1 +1 @@\r\n-broken\r\n+fixed\r\n");
  const before = { completed: true, collected: 3, passed: 2, failed: 1, errors: 0, skipped: 0, runner_exit_code: 1 };
  const after = { ...before, passed: 3, failed: 0, runner_exit_code: 0 };
  const repair = {
    run_id: "20260912T120000Z-abcdef12", verified_repair: true, status: "verified_repair", verifier_backend: "docker",
    repository: { slug: TARGET, url: `https://github.com/${TARGET}`, commit: "b".repeat(40) },
    baseline: { backend: "docker", command: "python -m pytest -q", verified: false, preparation_baseline_sha256: "c".repeat(64), verification_scope: "pytest_suite", execution: { exit_code: 1, timed_out: false, pytest_attestation: before } },
    final_verification: { backend: "docker", command: "python -m pytest -q", verified: true, repair_evidence_eligible: true, verification_scope: "pytest_suite", execution: { exit_code: 0, timed_out: false, pytest_attestation: after } },
    changed_files: ["src/app.py"], patch_sha256: sha256(patch),
  };
  repair.attestation_sha256 = sha256(Buffer.from([repair.run_id, repair.repository.commit, repair.baseline.command, 1, 0, repair.patch_sha256].join("|")));
  const envelope = { request_id: "R".repeat(43), mode: "verify", payload_sha256: "d".repeat(64), github_run_id: "1234", github_sha: "a".repeat(40), result: { ok: true, repair } };
  repair.artifacts = { github_actions_artifact: `repo-rescue-${envelope.request_id}`, available: ["patch", "evidence", "report"] };
  mutateEnvelope?.(envelope);
  const evidence = structuredClone(repair);
  evidence.artifacts = { run_id: repair.run_id, retrieval_tool: "get_repair_artifact", available: ["patch", "evidence", "report"] };
  mutateEvidence?.(evidence);
  const original = new Map([
    ["result.json", Buffer.from(JSON.stringify(envelope))],
    ["repair.patch", patch],
    ["evidence.json", Buffer.from(JSON.stringify(evidence))],
    ["report.md", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(`# Evidence\r\n${repair.run_id}\r\n`)])],
  ]);
  mutateZipFiles?.(original);
  const allFiles = new Map([...original, ["artifacts.zip", zipFiles(original)], ["receipt.html", Buffer.from("<!doctype html><html lang=\"zh-CN\"><body>RepoRescue · 原始修复证据</body></html>")]]);
  mutateDownload?.(allFiles);
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    assert.equal(options.method, "GET");
    assert.equal(options.redirect, "error");
    assert.equal(options.credentials, "omit");
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(options.headers.Cookie, undefined);
    assert.equal(options.headers.Referer, undefined);
    const name = url === URL ? "receipt.html" : url.slice(URL.length + 1);
    assert.ok(allFiles.has(name), "Only fixed receipt filenames may be requested");
    const override = changeResponse?.(name, options);
    if (override) return override;
    const body = allFiles.get(name);
    const type = name === "receipt.html" ? "text/html" : name === "artifacts.zip" ? "application/zip" : "application/octet-stream";
    return new Response(body, { status: 200, headers: { "content-type": type, "content-length": String(body.length) } });
  };
  return { calls, fetchImpl, files: allFiles, original, envelope };
}

test("anonymous audit saves six exact original downloads and the v3 manifest only after validation", async (t) => {
  const { out } = await outputFor(t);
  const mock = fixture();
  const result = await auditReceiptDownload({ url: URL, out, fetchImpl: mock.fetchImpl, now: () => NOW });
  assert.equal(mock.calls.length, 6);
  assert.deepEqual(Object.keys(result.report), ["receiptUrl", "checkedAt", "files"]);
  assert.equal(result.report.receiptUrl, URL);
  assert.equal(result.report.checkedAt, new Date(NOW).toISOString());
  assert.equal(result.report.files.length, 6);
  assert.equal((await readdir(out)).length, 7);
  for (const row of result.report.files) {
    assert.deepEqual(Object.keys(row), ["name", "sha256", "bytes"]);
    const saved = await readFile(join(out, row.name));
    assert.deepEqual(saved, mock.files.get(row.name));
    assert.equal(row.bytes, saved.length);
    assert.equal(row.sha256, sha256(saved));
  }
  assert.deepEqual(JSON.parse(await readFile(result.reportPath, "utf8")), result.report);
});

test("only fixed HTTPS receipt roots are accepted, with no network or output for invalid URLs", async (t) => {
  const { out } = await outputFor(t);
  for (const url of [URL.replace("https:", "http:"), URL.replace(ORIGIN, "https://other.example"), `${URL}/repair.patch`, `${URL}?x=1`, `${URL}#hash`, URL.replace("https://", "https://user:password@"), `${URL} `, "invalid", URL.replace("1234", "9007199254740992"), URL.replace(String(Math.floor((NOW + 86_400_000) / 1000)), "1700000000")]) {
    const mock = fixture();
    await assert.rejects(auditReceiptDownload({ url, out, fetchImpl: mock.fetchImpl, now: () => NOW }), /Receipt audit failed:/);
    assert.equal(mock.calls.length, 0);
    await assert.rejects(lstat(out), { code: "ENOENT" });
  }
});

test("existing output and missing parent directories are refused before downloads", async (t) => {
  const { root, out } = await outputFor(t);
  await mkdir(out);
  await writeFile(join(out, "keep.txt"), "existing user data");
  const mock = fixture();
  await assert.rejects(auditReceiptDownload({ url: URL, out, fetchImpl: mock.fetchImpl, now: () => NOW }), /already exists/);
  assert.equal(await readFile(join(out, "keep.txt"), "utf8"), "existing user data");
  await assert.rejects(auditReceiptDownload({ url: URL, out: join(root, "missing", "new"), fetchImpl: mock.fetchImpl, now: () => NOW }), /parent directory/);
  assert.equal(mock.calls.length, 0);
});

test("tampered downloads and extra ZIP files never leave output files", async (t) => {
  const { out } = await outputFor(t);
  for (const options of [
    { mutateDownload: (files) => files.set("repair.patch", Buffer.from("tampered")) },
    { mutateDownload: (files) => files.set("result.json", Buffer.from("{}")) },
    { mutateDownload: (files) => files.set("artifacts.zip", Buffer.from("not a zip")) },
    { mutateZipFiles: (files) => files.set("unexpected.txt", Buffer.from("unapproved artifact")) },
    { mutateZipFiles: (files) => files.delete("report.md"), mutateDownload: (files) => files.set("report.md", Buffer.from("missing zip entry")) },
  ]) {
    const mock = fixture(options);
    await assert.rejects(auditReceiptDownload({ url: URL, out, fetchImpl: mock.fetchImpl, now: () => NOW }), /Receipt audit failed:/);
    await assert.rejects(lstat(out), { code: "ENOENT" });
  }
});

test("matching ZIP bytes cannot disguise wrong-run, failed, private-target or false attestation evidence", async (t) => {
  const { out } = await outputFor(t);
  const mutations = [
    (v) => { v.github_run_id = "9999"; },
    (v) => { v.mode = "prepare"; },
    (v) => { v.result.ok = false; },
    (v) => { v.result.repair.verified_repair = false; },
    (v) => { v.result.repair.repository.slug = "unreviewed/private"; },
    (v) => { v.result.repair.attestation_sha256 = "a".repeat(64); },
    (v) => { v.result.repair.final_verification.command = "echo fake"; },
    (v) => { v.result.repair.final_verification.execution.pytest_attestation.skipped = 1; },
    (v) => { v.result.repair.artifacts.github_actions_artifact = "repo-rescue-other"; },
  ];
  for (const mutateEnvelope of mutations) {
    const mock = fixture({ mutateEnvelope });
    await assert.rejects(auditReceiptDownload({ url: URL, out, fetchImpl: mock.fetchImpl, now: () => NOW }), /Receipt audit failed:/);
    await assert.rejects(lstat(out), { code: "ENOENT" });
  }
});

test("audit compares the complete evidence record except validated transport descriptions", async (t) => {
  const { out } = await outputFor(t);
  for (const mutateEvidence of [(v) => { v.changed_files = ["other.py"]; }, (v) => { v.artifacts.run_id = "other"; }]) {
    const mock = fixture({ mutateEvidence });
    await assert.rejects(auditReceiptDownload({ url: URL, out, fetchImpl: mock.fetchImpl, now: () => NOW }), /Receipt audit failed:/);
    await assert.rejects(lstat(out), { code: "ENOENT" });
  }
});

test("wrong content type, declared oversize and redirects fail without persisting or echoing URL", async (t) => {
  const { out } = await outputFor(t);
  const responses = [
    () => new Response("wrong type", { headers: { "content-type": "application/json" } }),
    () => new Response("oversize", { headers: { "content-type": "text/html", "content-length": String(600 * 1024) } }),
    () => new Response(null, { status: 302, headers: { location: "https://different.example/private" } }),
    () => new Response("not available", { status: 503 }),
  ];
  for (const changed of responses) {
    const mock = fixture({ changeResponse: () => changed() });
    await assert.rejects(auditReceiptDownload({ url: URL, out, fetchImpl: mock.fetchImpl, now: () => NOW }), (error) => {
      assert.equal(error.message.includes(URL), false);
      assert.equal(error.message.includes("different.example"), false);
      return true;
    });
    assert.equal(mock.calls.length, 1);
    await assert.rejects(lstat(out), { code: "ENOENT" });
  }
});

test("streamed oversize and truncated downloads are rejected even without trustworthy headers", async (t) => {
  const { out } = await outputFor(t);
  for (const response of [
    () => new Response(Buffer.alloc(513 * 1024), { headers: { "content-type": "text/html" } }),
    () => new Response("short", { headers: { "content-type": "text/html", "content-length": "100" } }),
  ]) {
    const mock = fixture({ changeResponse: () => response() });
    await assert.rejects(auditReceiptDownload({ url: URL, out, fetchImpl: mock.fetchImpl, now: () => NOW }), /Receipt audit failed:/);
    await assert.rejects(lstat(out), { code: "ENOENT" });
  }
});

test("stalled fetch is aborted within the bounded timeout and provider errors are sanitized", async (t) => {
  const { out } = await outputFor(t);
  const fetchImpl = async (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error(`secret ${URL}`)), { once: true }));
  await assert.rejects(auditReceiptDownload({ url: URL, out, fetchImpl, now: () => NOW, requestTimeoutMs: 10, totalTimeoutMs: 100 }), (error) => {
    assert.match(error.message, /time limit/);
    assert.equal(error.message.includes(URL), false);
    return true;
  });
  await assert.rejects(lstat(out), { code: "ENOENT" });
});

test("directory created during verification cannot be overwritten", async (t) => {
  const { out } = await outputFor(t);
  const mock = fixture();
  const originalFetch = mock.fetchImpl;
  let created = false;
  const fetchImpl = async (...args) => {
    if (!created) { created = true; await mkdir(out); await writeFile(join(out, "keep.txt"), "concurrent user data"); }
    return originalFetch(...args);
  };
  await assert.rejects(auditReceiptDownload({ url: URL, out, fetchImpl, now: () => NOW }), /exclusively created/);
  assert.deepEqual(await readdir(out), ["keep.txt"]);
  assert.equal(await readFile(join(out, "keep.txt"), "utf8"), "concurrent user data");
});

test("CLI accepts only the two documented arguments and never logs supplied capabilities", () => {
  const script = fileURLToPath(new globalThis.URL("../scripts/audit-receipt-download.mjs", import.meta.url));
  const environment = {};
  for (const key of ["SystemRoot", "WINDIR", "PATH", "Path"]) if (process.env[key] !== undefined) environment[key] = process.env[key];
  const execution = spawnSync(process.execPath, [script, "--unsupported", URL], { encoding: "utf8", env: environment, timeout: 5000, windowsHide: true });
  assert.equal(execution.status, 1);
  assert.match(execution.stderr, /usage is --url RECEIPT_URL --out NEW_DIRECTORY/);
  assert.equal(`${execution.stdout}${execution.stderr}`.includes(URL), false);
});
