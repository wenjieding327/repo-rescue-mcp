#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstat, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extractBridgeArtifact } from "../actions-bridge.mjs";

const ORIGIN = "https://reporescue-mcp-production.up.railway.app";
const ROUTE = /^\/r\/v1\.([1-9][0-9]{0,15})\.([1-9][0-9]{0,15})\.([1-9][0-9]{9})\.[A-Za-z0-9_-]{32}\/?$/;
const REVIEWED_REPOSITORIES = new Set(["wenjieding327/repo-rescue-mcp", "wenjieding327/repo-rescue-canary"]);
const ARTIFACT_FILES = ["result.json", "repair.patch", "evidence.json", "report.md"];
const DOWNLOADS = [
  { name: "receipt.html", suffix: "", max: 512 * 1024, type: "text/html" },
  ...ARTIFACT_FILES.map((name) => ({ name, suffix: `/${name}`, max: (name === "result.json" ? 1 : 4) * 1024 * 1024, type: "application/octet-stream" })),
  { name: "artifacts.zip", suffix: "/artifacts.zip", max: 8 * 1024 * 1024, type: "application/zip" },
];
const MAX_TOTAL_BYTES = 18 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 45_000;
const TOTAL_TIMEOUT_MS = 90_000;
const REPORT_NAME = "receipt-download-audit.json";
const HASH = /^[0-9a-f]{64}$/;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function rejected(reason) { return new Error(`Receipt audit failed: ${reason}.`); }

function parseReceipt(value, now) {
  let parsed;
  try { parsed = new URL(value); } catch { throw rejected("invalid receipt URL"); }
  const match = ROUTE.exec(parsed.pathname);
  if (typeof value !== "string" || value.trim() !== value || parsed.origin !== ORIGIN
    || parsed.username || parsed.password || parsed.search || parsed.hash || !match
    || !Number.isSafeInteger(Number(match[1])) || !Number.isSafeInteger(Number(match[2]))
    || Number(match[3]) * 1000 <= now) throw rejected("unsupported or expired receipt URL");
  return { url: `${ORIGIN}${parsed.pathname.replace(/\/$/, "")}`, runId: Number(match[1]) };
}

async function ensureNewOutput(value) {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) throw rejected("an explicit new output directory is required");
  const output = resolve(value);
  if (output === parse(output).root) throw rejected("output cannot be a filesystem root");
  try {
    await lstat(output);
    throw rejected("output directory already exists; nothing will be overwritten");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  let parent;
  try { parent = await lstat(dirname(output)); } catch { throw rejected("output parent directory must already exist"); }
  if (!parent.isDirectory() || parent.isSymbolicLink()) throw rejected("output parent must be an existing real directory");
  return output;
}

async function download(url, expected, fetchImpl, totalSignal, timeoutMs) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  totalSignal.addEventListener("abort", cancel, { once: true });
  if (totalSignal.aborted) cancel();
  const timer = setTimeout(cancel, timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "GET", redirect: "error", credentials: "omit", signal: controller.signal,
      headers: { Accept: expected.type, "User-Agent": "repo-rescue-receipt-audit" },
    });
    if (controller.signal.aborted || response.status !== 200 || response.redirected === true) throw rejected("download did not return a direct successful response");
    if (response.url && response.url !== url) throw rejected("download response URL changed");
    const type = String(response.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
    if (type !== expected.type) throw rejected("download content type did not match the receipt contract");
    const declared = response.headers.get("content-length");
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > expected.max)) throw rejected("download declared an invalid size");
    const chunks = [];
    let length = 0;
    if (!response.body?.getReader) throw rejected("download did not provide a bounded response stream");
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (controller.signal.aborted) throw rejected("download exceeded its time limit");
        if (done) break;
        length += value.byteLength;
        if (length > expected.max) throw rejected("download exceeded its byte limit");
        chunks.push(Buffer.from(value));
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    if (!length || (declared !== null && Number(declared) !== length)) throw rejected("download was empty or truncated");
    return Buffer.concat(chunks, length);
  } catch (error) {
    // Never echo a capability URL, provider response, redirect, or ambient token.
    if (error?.message?.startsWith("Receipt audit failed:")) throw error;
    throw rejected(controller.signal.aborted ? "download exceeded its time limit" : "anonymous download was unavailable");
  } finally {
    clearTimeout(timer);
    totalSignal.removeEventListener("abort", cancel);
  }
}

function jsonFile(bytes) {
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw rejected("artifact JSON was invalid"); }
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

function verifyDownloads(downloaded, runId) {
  let extracted;
  try { extracted = extractBridgeArtifact(downloaded.get("artifacts.zip"), { strictFiles: true }); } catch { throw rejected("original ZIP was invalid"); }
  if (extracted.size !== ARTIFACT_FILES.length) throw rejected("original ZIP did not contain exactly four evidence files");
  for (const name of ARTIFACT_FILES) {
    if (!extracted.has(name) || !extracted.get(name).equals(downloaded.get(name))) throw rejected("a download differed from the original ZIP bytes");
  }
  const result = jsonFile(downloaded.get("result.json"));
  const evidence = jsonFile(downloaded.get("evidence.json"));
  const repair = result?.result?.repair;
  const baseline = repair?.baseline;
  const final = repair?.final_verification;
  const { artifacts: resultTransport, ...resultEvidence } = repair || {};
  const { artifacts: evidenceTransport, ...recordedEvidence } = evidence || {};
  if (result?.mode !== "verify" || String(result.github_run_id) !== String(runId)
    || !/^[A-Za-z0-9_-]{43}$/.test(String(result.request_id || ""))
    || !HASH.test(String(result.payload_sha256 || "")) || !/^[0-9a-f]{40}$/.test(String(result.github_sha || ""))
    || result.result?.ok !== true || repair?.verified_repair !== true || repair?.status !== "verified_repair"
    || !/^[A-Za-z0-9_-]{1,100}$/.test(String(repair?.run_id || ""))
    || !REVIEWED_REPOSITORIES.has(repair?.repository?.slug)
    || !/^[0-9a-f]{40}$/.test(String(repair?.repository?.commit || ""))
    || repair?.repository?.url !== `https://github.com/${repair?.repository?.slug}`
    || repair?.verifier_backend !== "docker" || baseline?.backend !== "docker" || final?.backend !== "docker"
    || baseline?.verified !== false || final?.verified !== true || final?.repair_evidence_eligible !== true
    || typeof baseline?.command !== "string" || !baseline.command.trim() || baseline.command !== final?.command
    || !Number.isSafeInteger(baseline?.execution?.exit_code) || baseline.execution.exit_code === 0
    || baseline?.execution?.timed_out !== false || final?.execution?.exit_code !== 0 || final?.execution?.timed_out !== false
    || !HASH.test(String(baseline?.preparation_baseline_sha256 || ""))
    || repair?.patch_sha256 !== sha256(downloaded.get("repair.patch"))
    || (resultTransport?.github_actions_artifact !== undefined && resultTransport.github_actions_artifact !== `repo-rescue-${result.request_id}`)
    || (evidenceTransport !== undefined && evidenceTransport?.run_id !== repair.run_id)
    || JSON.stringify(canonical(resultEvidence)) !== JSON.stringify(canonical(recordedEvidence))) throw rejected("artifact repair evidence was not bound to the requested verified run");
  const attestation = [repair.run_id, repair.repository.commit, baseline.command, baseline.execution.exit_code, final.execution.exit_code, repair.patch_sha256].join("|");
  if (repair.attestation_sha256 !== sha256(Buffer.from(attestation))) throw rejected("verification attestation did not match");
  if (baseline.verification_scope === "pytest_suite" || final.verification_scope === "pytest_suite") {
    const before = baseline.execution.pytest_attestation;
    const after = final.execution.pytest_attestation;
    const counts = (value) => value?.completed === true && ["collected", "passed", "failed", "errors", "skipped"].every((key) => Number.isSafeInteger(value[key]) && value[key] >= 0);
    if (!counts(before) || !counts(after) || before.collected < 1 || after.collected < before.collected
      || before.runner_exit_code !== baseline.execution.exit_code || after.runner_exit_code !== 0
      || after.passed < 1 || after.failed !== 0 || after.errors !== 0 || after.skipped > before.skipped
      || after.passed + after.skipped !== after.collected) throw rejected("pytest coverage was incomplete or weakened");
  }
  let report;
  let html;
  try {
    report = new TextDecoder("utf-8", { fatal: true }).decode(downloaded.get("report.md"));
    html = new TextDecoder("utf-8", { fatal: true }).decode(downloaded.get("receipt.html"));
  } catch { throw rejected("receipt text was not valid UTF-8"); }
  if (!report.includes(repair.run_id) || !/^\s*(?:<!doctype html[^>]*>\s*)?<html\b/i.test(html)) throw rejected("report or receipt page did not match its content contract");
}

/** Anonymous, read-only audit. No credential or local configuration is read. */
export async function auditReceiptDownload({ url, out, fetchImpl = globalThis.fetch, now = Date.now, requestTimeoutMs = REQUEST_TIMEOUT_MS, totalTimeoutMs = TOTAL_TIMEOUT_MS } = {}) {
  const identity = parseReceipt(url, now());
  const output = await ensureNewOutput(out);
  if (typeof fetchImpl !== "function" || !Number.isFinite(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > REQUEST_TIMEOUT_MS
    || !Number.isFinite(totalTimeoutMs) || totalTimeoutMs < 1 || totalTimeoutMs > TOTAL_TIMEOUT_MS) throw rejected("invalid audit runtime configuration");
  const total = new AbortController();
  const timer = setTimeout(() => total.abort(), totalTimeoutMs);
  const downloaded = new Map();
  let totalBytes = 0;
  try {
    for (const expected of DOWNLOADS) {
      if (total.signal.aborted) throw rejected("audit exceeded its total time limit");
      const content = await download(`${identity.url}${expected.suffix}`, expected, fetchImpl, total.signal, requestTimeoutMs);
      totalBytes += content.length;
      if (totalBytes > MAX_TOTAL_BYTES) throw rejected("combined download exceeded its byte limit");
      downloaded.set(expected.name, content);
    }
    verifyDownloads(downloaded, identity.runId);
    if (total.signal.aborted) throw rejected("audit exceeded its total time limit");
  } finally { clearTimeout(timer); }
  const report = {
    receiptUrl: identity.url,
    checkedAt: new Date(now()).toISOString(),
    files: [...downloaded].map(([name, bytes]) => ({ name, sha256: sha256(bytes), bytes: bytes.length })),
  };
  // Atomic directory creation and exclusive file creation prevent overwrites,
  // including a target created while downloads were being verified.
  try { await mkdir(output); } catch { throw rejected("output directory could not be exclusively created"); }
  try {
    for (const [name, content] of downloaded) await writeFile(join(output, name), content, { flag: "wx", mode: 0o600 });
    await writeFile(join(output, REPORT_NAME), `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  } catch { throw rejected("verified output could not be fully saved; inspect the new output directory"); }
  return { report, reportPath: join(output, REPORT_NAME), outputDirectory: output };
}

function cliArguments(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const name = flag === "--url" ? "url" : flag === "--out" ? "out" : null;
    if (!name || parsed[name] !== undefined || typeof args[index + 1] !== "string" || args[index + 1].startsWith("--")) throw rejected("usage is --url RECEIPT_URL --out NEW_DIRECTORY");
    parsed[name] = args[index + 1];
  }
  if (!parsed.url || !parsed.out) throw rejected("usage is --url RECEIPT_URL --out NEW_DIRECTORY");
  return parsed;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await auditReceiptDownload(cliArguments(process.argv.slice(2)));
    process.stdout.write(`Receipt audit PASS: ${result.report.files.length} original downloads verified.\nReport: ${result.reportPath}\n`);
  } catch (error) {
    const message = error?.message?.startsWith("Receipt audit failed:") ? error.message : "Receipt audit failed: unexpected local error.";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
