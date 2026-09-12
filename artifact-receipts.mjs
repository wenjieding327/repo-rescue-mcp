import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const REPOSITORY = "wenjieding327/repo-rescue-mcp";
const REVIEWED_REPOSITORIES = new Set([REPOSITORY, "wenjieding327/repo-rescue-canary"]);
const FILE_NAMES = Object.freeze(["repair.patch", "evidence.json", "report.md", "result.json"]);
const MAX_LIFETIME_MS = 7 * 24 * 60 * 60_000;
const MAX_ZIP_BYTES = 8 * 1024 * 1024;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_CACHE_BYTES = 32 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 16;
const CACHE_LIFETIME_MS = 5 * 60_000;
const MAX_CONCURRENT_LOADS = 2;
const MAX_REQUESTS_PER_MINUTE = 120;
const SHA256 = /^[0-9a-f]{64}$/;
const SHA1 = /^[0-9a-f]{40}$/;
const RECEIPT_PATH = /^\/r\/(v1\.([1-9][0-9]{0,15})\.([1-9][0-9]{0,15})\.([1-9][0-9]{9})\.([A-Za-z0-9_-]{32}))(?:\/(repair\.patch|evidence\.json|report\.md|result\.json|artifacts\.zip))?\/?$/;

function digest(value) { return createHash("sha256").update(value).digest("hex"); }
function positiveId(value) { return Number.isSafeInteger(value) && value > 0; }
function expiryMillis(value) { return typeof value === "string" ? Date.parse(value) : NaN; }
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function preview(value) {
  const text = String(value ?? "未提供");
  return escapeHtml(text.length <= 32_768 ? text : `${text.slice(0, 32_768)}\n[预览已截断；原始下载文件保持完整。]`);
}

function verifiedResult(value) {
  const repair = value?.repair;
  return value?.ok === true && repair?.verified_repair === true
    && repair.status === "verified_repair"
    && REVIEWED_REPOSITORIES.has(repair.repository?.slug)
    && SHA1.test(String(repair.repository?.commit || ""))
    && SHA256.test(String(repair.patch_sha256 || ""));
}

function safeMetadata(value) {
  return value?.repository === REPOSITORY
    && positiveId(value.workflow_run_id) && positiveId(value.artifact_id)
    && SHA1.test(String(value.head_sha || ""))
    && /^repo-rescue-[A-Za-z0-9_-]{43}$/.test(String(value.artifact_name || ""))
    && /^sha256:[0-9a-f]{64}$/.test(String(value.artifact_digest || ""))
    && FILE_NAMES.every((name) => Number.isSafeInteger(value.files?.[name]?.bytes)
      && value.files[name].bytes > 0 && value.files[name].bytes <= MAX_FILE_BYTES
      && SHA256.test(String(value.files[name].sha256 || "")));
}

function responseHeaders(type, length) {
  return {
    "Content-Type": type,
    "Content-Length": String(length),
    "Cache-Control": "no-store, max-age=0",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "X-Robots-Tag": "noindex, nofollow, noarchive",
    "Content-Security-Policy": "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  };
}

function respond(request, response, status, body, type = "text/plain; charset=utf-8", extra = {}) {
  if (response.destroyed || response.writableEnded) return;
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8");
  response.writeHead(status, { ...responseHeaders(type, bytes.length), ...extra });
  response.end(request.method === "HEAD" ? undefined : bytes);
}

function testSummary(verification) {
  const record = verification?.execution?.pytest_attestation;
  if (record?.completed === true && ["passed", "failed", "errors", "collected"].every(
    (name) => Number.isSafeInteger(record[name]) && record[name] >= 0,
  )) return `${record.passed} 通过 / ${record.failed} 失败 / ${record.errors} 错误（收集 ${record.collected} 项）`;
  return "未提供完整测试数量；请查看原始 evidence.json。";
}

function receiptHtml(bundle, token, expiresAt) {
  const repair = bundle.result.result.repair;
  const base = `/r/${token}`;
  const runUrl = `https://github.com/${REPOSITORY}/actions/runs/${bundle.metadata.workflow_run_id}`;
  const rows = FILE_NAMES.map((name) => {
    const bytes = bundle.files.get(name);
    return `<tr><td><a href="${base}/${name}" download="${name}">${name}</a></td><td>${bytes.length}</td><td class="hash">${digest(bytes)}</td></tr>`;
  }).join("");
  const logs = [
    ["修改前测试输出", repair.baseline?.execution?.stdout],
    ["修改后测试输出", repair.final_verification?.execution?.stdout],
  ].map(([title, value]) => `<details><summary>${title}</summary><pre>${preview(value || "未提供")}</pre></details>`).join("");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>RepoRescue · 原始修复证据</title><style>
body{font:16px/1.6 system-ui,sans-serif;color:#182437;background:#f3f6fa;margin:0;padding:32px 16px}main{max-width:1050px;margin:auto;background:#fff;padding:28px;border-radius:16px}h1{margin:0 0 8px;font-size:28px}h2{margin-top:28px;font-size:20px}.status{color:#146c43;font-weight:700}.muted{color:#536174;font-size:14px}a{color:#174faa}table{border-collapse:collapse;width:100%;font-size:14px}th,td{text-align:left;padding:10px;border-bottom:1px solid #dce3ec;vertical-align:top}.hash{font-family:monospace;overflow-wrap:anywhere}dl{display:grid;grid-template-columns:110px 1fr;gap:8px}dt{font-weight:600}dd{margin:0;overflow-wrap:anywhere}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f3f6fa;padding:16px;font-size:13px}summary{cursor:pointer;padding:12px 0}.notice{background:#fff6df;padding:12px;border-radius:8px}@media(max-width:650px){main{padding:18px}dl{grid-template-columns:1fr}table{font-size:12px}}
</style></head><body><main><h1>RepoRescue · 原始修复证据</h1><p class="status">已真实验证修复</p><p class="muted">此页面由后端根据 GitHub Actions 原始产物生成，不是模型重新抄写的补丁或报告。</p>
<dl><dt>目标仓库</dt><dd>${escapeHtml(repair.repository.slug)}</dd><dt>固定提交</dt><dd class="hash">${escapeHtml(repair.repository.commit)}</dd><dt>修改前</dt><dd>${escapeHtml(testSummary(repair.baseline))}</dd><dt>修改后</dt><dd>${escapeHtml(testSummary(repair.final_verification))}</dd><dt>验证命令</dt><dd>${escapeHtml(repair.final_verification?.command || "未提供")}</dd><dt>运行证据</dt><dd><a href="${runUrl}" rel="noreferrer noopener">打开本次 GitHub Actions 运行</a></dd></dl>
<h2>下载原始文件</h2><p>下载内容保留原始字节、缩进和换行。下面 SHA-256 由服务器对下载字节计算。</p><table><thead><tr><th>原始文件</th><th>字节</th><th>SHA-256</th></tr></thead><tbody>${rows}</tbody></table><p><a href="${base}/artifacts.zip" download="reporescue-artifacts.zip">下载完整原始 ZIP</a></p>
<p class="notice">只读分享链接预计有效至 ${escapeHtml(new Date(expiresAt).toISOString())}。持有链接即可读取这些公开仓库的修复产物；请及时下载留存。GitHub 提前删除产物、凭据失效或服务配置变化也可能使链接不可用。</p>
<h2>真实执行记录</h2>${logs}<details><summary>补丁预览（复制修改请优先使用原始下载）</summary><pre>${preview(bundle.files.get("repair.patch").toString("utf8"))}</pre></details><details><summary>原始报告预览</summary><pre>${preview(bundle.files.get("report.md").toString("utf8"))}</pre></details>
<p class="muted">仅证明本次固定提交及记录的测试范围已通过，不等于任意项目、全部场景或论文结论已完整复现。</p></main></body></html>`;
}

/** A share capability grants immutable artifact reads only, never job execution. */
export function createArtifactReceipts({ signingKey, publicOrigin, loadArtifact, now = Date.now } = {}) {
  const key = Buffer.isBuffer(signingKey) ? Buffer.from(signingKey) : Buffer.from(String(signingKey || ""), "utf8");
  if (key.length < 32 || key.length > 512) throw new Error("Receipt signing key must contain 32 to 512 bytes.");
  let origin;
  try { origin = new URL(publicOrigin); } catch { throw new Error("Receipt public origin must be a fixed HTTPS origin."); }
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.search || origin.hash
    || origin.pathname !== "/") throw new Error("Receipt public origin must be a fixed HTTPS origin.");
  if (typeof loadArtifact !== "function" || typeof now !== "function") throw new Error("Receipt loader and clock are required.");
  const receiptKey = createHmac("sha256", key).update("RepoRescue/read-only-artifact-receipts/key/v1\0").digest();
  const cache = new Map();
  const inflight = new Map();
  let cacheBytes = 0;
  let requestTimes = [];
  let closed = false;

  function signature(payload) {
    return createHmac("sha256", receiptKey).update(payload).digest().subarray(0, 24).toString("base64url");
  }

  function mint(result) {
    if (closed || !verifiedResult(result) || !safeMetadata(result.github_actions)) return "";
    const metadata = result.github_actions;
    if (metadata.files["repair.patch"].sha256 !== result.repair.patch_sha256) return "";
    const current = now();
    const expiry = Math.min(expiryMillis(metadata.artifact_expires_at), current + MAX_LIFETIME_MS);
    const seconds = Math.floor(expiry / 1000);
    if (!Number.isSafeInteger(seconds) || seconds <= Math.floor(current / 1000)) return "";
    const payload = `v1.${metadata.workflow_run_id}.${metadata.artifact_id}.${seconds}`;
    return `${origin.origin}/r/${payload}.${signature(payload)}`;
  }

  function removeCached(keyName) {
    const entry = cache.get(keyName);
    if (entry) cacheBytes -= entry.bytes;
    cache.delete(keyName);
  }

  function purgeCache() {
    for (const [keyName, entry] of cache) if (entry.until <= now()) removeCached(keyName);
  }

  function checkBundle(bundle, runId, artifactId) {
    if (!(bundle?.files instanceof Map) || !Buffer.isBuffer(bundle.zip) || !bundle.zip.length
      || bundle.zip.length > MAX_ZIP_BYTES || bundle.files.size !== FILE_NAMES.length
      || !safeMetadata(bundle.metadata) || bundle.metadata.workflow_run_id !== runId
      || bundle.metadata.artifact_id !== artifactId || bundle.result?.mode !== "verify"
      || String(bundle.result.github_run_id) !== String(runId)
      || bundle.result.github_sha !== bundle.metadata.head_sha
      || !verifiedResult(bundle.result.result)
      || bundle.metadata.artifact_digest !== `sha256:${digest(bundle.zip)}`
      || !Number.isFinite(expiryMillis(bundle.expiresAt)) || expiryMillis(bundle.expiresAt) <= now()
      || expiryMillis(bundle.expiresAt) !== expiryMillis(bundle.metadata.artifact_expires_at)) {
      throw new Error("receipt_bundle_invalid");
    }
    let size = bundle.zip.length;
    const files = new Map();
    for (const name of FILE_NAMES) {
      const bytes = bundle.files.get(name);
      const metadata = bundle.metadata.files[name];
      if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_FILE_BYTES
        || bytes.length !== metadata.bytes || digest(bytes) !== metadata.sha256) throw new Error("receipt_bundle_invalid");
      size += bytes.length;
      files.set(name, Buffer.from(bytes));
    }
    if (size - bundle.zip.length > MAX_ZIP_BYTES
      || digest(files.get("repair.patch")) !== bundle.result.result.repair.patch_sha256) throw new Error("receipt_bundle_invalid");
    let envelope;
    try { envelope = JSON.parse(files.get("result.json").toString("utf8")); } catch { throw new Error("receipt_bundle_invalid"); }
    if (JSON.stringify(envelope) !== JSON.stringify(bundle.result)) throw new Error("receipt_bundle_invalid");
    // Retain only the metadata needed to render the receipt. In particular,
    // artifact_contents is a redundant text copy, not the downloadable bytes.
    return { bundle: {
      files, zip: Buffer.from(bundle.zip), result: envelope, expiresAt: bundle.expiresAt,
      metadata: { workflow_run_id: runId, artifact_id: artifactId },
    }, bytes: size };
  }

  async function obtain(runId, artifactId) {
    purgeCache();
    const keyName = `${runId}:${artifactId}`;
    const cached = cache.get(keyName);
    if (cached) {
      cache.delete(keyName);
      cache.set(keyName, cached);
      return cached.bundle;
    }
    if (inflight.has(keyName)) return inflight.get(keyName);
    if (inflight.size >= MAX_CONCURRENT_LOADS) throw new Error("receipt_capacity_reached");
    const loading = Promise.resolve().then(() => loadArtifact({ runId, artifactId })).then((value) => {
      const entry = checkBundle(value, runId, artifactId);
      if (closed) throw new Error("receipt_service_closed");
      entry.until = Math.min(now() + CACHE_LIFETIME_MS, expiryMillis(entry.bundle.expiresAt));
      while (cache.size && (cache.size >= MAX_CACHE_ENTRIES || cacheBytes + entry.bytes > MAX_CACHE_BYTES)) {
        removeCached(cache.keys().next().value);
      }
      cache.set(keyName, entry);
      cacheBytes += entry.bytes;
      return entry.bundle;
    }).finally(() => inflight.delete(keyName));
    inflight.set(keyName, loading);
    return loading;
  }

  async function handle(request, response) {
    const rawPath = String(request.url || "");
    if (!rawPath.startsWith("/r/") && rawPath !== "/r") return false;
    if (closed) { respond(request, response, 503, "收据服务暂不可用。\n"); return true; }
    if (request.method !== "GET" && request.method !== "HEAD") {
      respond(request, response, 405, "仅允许只读访问。\n", undefined, { Allow: "GET, HEAD" }); return true;
    }
    const current = now();
    requestTimes = requestTimes.filter((time) => current - time < 60_000);
    if (requestTimes.length >= MAX_REQUESTS_PER_MINUTE) {
      respond(request, response, 429, "读取频率过高，请稍后重试。\n", undefined, { "Retry-After": "60" }); return true;
    }
    requestTimes.push(current);
    const match = RECEIPT_PATH.exec(rawPath);
    const runId = Number(match?.[2]);
    const artifactId = Number(match?.[3]);
    if (!match || !positiveId(runId) || !positiveId(artifactId)) {
      respond(request, response, 404, "收据不存在或链接无效。\n"); return true;
    }
    const [, token, , , seconds, supplied, filename] = match;
    const payload = token.slice(0, token.lastIndexOf("."));
    if (!timingSafeEqual(Buffer.from(supplied, "ascii"), Buffer.from(signature(payload), "ascii"))) {
      respond(request, response, 404, "收据不存在或链接无效。\n"); return true;
    }
    const expiry = Number(seconds) * 1000;
    if (expiry <= current || expiry > current + MAX_LIFETIME_MS) {
      respond(request, response, 410, "收据链接已过期或不在有效时间范围内。请使用已下载的原始文件，或重新运行修复。\n"); return true;
    }
    try {
      const bundle = await obtain(runId, artifactId);
      if (closed) { respond(request, response, 503, "收据服务暂不可用。\n"); return true; }
      if (response.destroyed || response.writableEnded) return true;
      const effectiveExpiry = Math.min(expiry, expiryMillis(bundle.expiresAt));
      if (effectiveExpiry <= now()) {
        respond(request, response, 410, "原始产物已过期。\n"); return true;
      }
      if (!filename) {
        respond(request, response, 200, receiptHtml(bundle, token, effectiveExpiry), "text/html; charset=utf-8");
      } else {
        const zip = filename === "artifacts.zip";
        respond(request, response, 200, zip ? bundle.zip : bundle.files.get(filename),
          zip ? "application/zip" : "application/octet-stream", {
            "Content-Disposition": `attachment; filename="${zip ? "reporescue-artifacts.zip" : filename}"`,
          });
      }
    } catch (error) {
      // Provider bodies, credential-bearing redirect URLs, and private job state
      // must never become an anonymous error response.
      const capacity = error?.message === "receipt_capacity_reached";
      respond(request, response, capacity ? 429 : 503,
        capacity ? "当前下载繁忙，请稍后重试。\n" : "原始产物暂不可用或已被删除；未生成替代文件，请稍后重试。\n",
        undefined, { "Retry-After": capacity ? "5" : "30" });
    }
    return true;
  }

  function close() { closed = true; cache.clear(); cacheBytes = 0; requestTimes = []; }
  return { mint, handle, close };
}
