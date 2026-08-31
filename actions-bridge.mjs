import { createHash, randomBytes } from "node:crypto";
import { gunzipSync, gzipSync, inflateRawSync } from "node:zlib";

export const ACTIONS_BRIDGE_LIMITS = Object.freeze({
  maxDispatchPayloadChars: 55_000,
  maxDecodedPayloadBytes: 55_000,
  maxJsonResponseBytes: 1_048_576,
  maxArtifactZipBytes: 8 * 1_048_576,
  maxArtifactFileBytes: 4 * 1_048_576,
  maxArtifactEntries: 64,
  maxWaitSeconds: 20,
});

const API_VERSION = "2026-03-10";
const DEFAULT_REPOSITORY = "wenjieding327/repo-rescue-mcp";
const DEFAULT_WORKFLOW = "repo-rescue-actions-bridge.yml";
const DEFAULT_REF = "main";
const REVIEWED_PLATFORM_REPOSITORIES = Object.freeze([
  "wenjieding327/repo-rescue-canary",
  "wenjieding327/repo-rescue-mcp",
]);
const RESULT_FILES = new Set(["result.json", "repair.patch", "evidence.json", "report.md"]);
const TERMINAL_RUN_STATUS = "completed";
const SECRET_PATTERN = /(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|bearer\s+[^\s,;]+)/gi;

export class ActionsBridgeError extends Error {
  constructor(code, message, { retryAfterMs = 0 } = {}) {
    super(message);
    this.name = "ActionsBridgeError";
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

function canonicalRepository(value) {
  const candidate = String(value || "").trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(candidate)) {
    throw new ActionsBridgeError("configuration_required", "The Actions repository configuration is invalid.");
  }
  return candidate.toLowerCase();
}

function configuredWorkflow(value) {
  const candidate = String(value || DEFAULT_WORKFLOW).trim();
  if (!/^(?:[1-9][0-9]{0,19}|[A-Za-z0-9_.-]+\.ya?ml)$/.test(candidate)) {
    throw new ActionsBridgeError("configuration_required", "The Actions workflow configuration is invalid.");
  }
  return candidate;
}

function configuredRef(value) {
  const candidate = String(value || DEFAULT_REF).trim().replace(/^refs\/heads\//, "");
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(candidate)
    || candidate.includes("..")
    || candidate.includes("//")
    || candidate.endsWith("/")
    || candidate.endsWith(".lock")
  ) {
    throw new ActionsBridgeError("configuration_required", "The Actions branch configuration is invalid.");
  }
  return candidate;
}

function configuredAllowedRepositories(value) {
  const items = String(value || "").split(",").map((item) => item.trim().toLowerCase().replace(/\.git$/, "")).filter(Boolean);
  if (!items.length || items.some((item) => !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(item))) {
    throw new ActionsBridgeError("configuration_required", "The platform repository allow-list is missing or invalid.");
  }
  return new Set(items);
}

function sameSet(left, right) {
  return left.size === right.size && [...left].every((item) => right.has(item));
}

function safeProviderMessage(error, token = "") {
  let message = error instanceof ActionsBridgeError
    ? error.message
    : "GitHub Actions could not complete the request safely.";
  if (token) message = message.split(token).join("[REDACTED]");
  return message.replace(SECRET_PATTERN, "[REDACTED]").slice(0, 1_000);
}

function base64UrlId() {
  return randomBytes(32).toString("base64url");
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function byteLengthJson(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
  }
  return value;
}

export function encodeDispatchPayload(mode, args) {
  if (!new Set(["prepare", "verify"]).has(mode)) {
    throw new ActionsBridgeError("invalid_request", "Unknown bridge operation.");
  }
  const raw = Buffer.from(JSON.stringify(canonicalValue({ version: 1, mode, arguments: args })), "utf8");
  if (raw.length > ACTIONS_BRIDGE_LIMITS.maxDecodedPayloadBytes) {
    throw new ActionsBridgeError("payload_too_large", "The repair request exceeds the decoded payload limit.");
  }
  const encoded = gzipSync(raw, { level: 9 }).toString("base64");
  if (encoded.length > ACTIONS_BRIDGE_LIMITS.maxDispatchPayloadChars) {
    throw new ActionsBridgeError(
      "payload_too_large",
      `The compressed workflow payload exceeds ${ACTIONS_BRIDGE_LIMITS.maxDispatchPayloadChars} characters.`,
    );
  }
  return encoded;
}

async function readBoundedBody(response, maximumBytes) {
  if (!response.body?.getReader) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maximumBytes) throw new ActionsBridgeError("provider_response_too_large", "GitHub returned an oversized response.");
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      throw new ActionsBridgeError("provider_response_too_large", "GitHub returned an oversized response.");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

function parseJsonBytes(bytes) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new ActionsBridgeError("provider_protocol_error", "GitHub returned an invalid JSON response.");
  }
}

function decodeUtf8(bytes, label) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ActionsBridgeError("artifact_invalid", `${label} is not valid UTF-8.`);
  }
}

function safeZipPath(name) {
  return Boolean(
    name
    && !name.includes("\\")
    && !name.includes("\0")
    && !name.startsWith("/")
    && !/^[A-Za-z]:/.test(name)
    && !name.split("/").includes("..")
  );
}

function findEndOfCentralDirectory(zip) {
  const minimum = Math.max(0, zip.length - 65_557);
  for (let offset = zip.length - 22; offset >= minimum; offset -= 1) {
    if (zip.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new ActionsBridgeError("artifact_invalid", "The GitHub artifact is not a supported ZIP archive.");
}

export function extractBridgeArtifact(zipBytes) {
  const zip = Buffer.from(zipBytes);
  if (zip.length > ACTIONS_BRIDGE_LIMITS.maxArtifactZipBytes) {
    throw new ActionsBridgeError("artifact_too_large", "The GitHub artifact ZIP exceeds the download limit.");
  }
  const end = findEndOfCentralDirectory(zip);
  const disk = zip.readUInt16LE(end + 4);
  const centralDisk = zip.readUInt16LE(end + 6);
  const entriesOnDisk = zip.readUInt16LE(end + 8);
  const entries = zip.readUInt16LE(end + 10);
  const centralSize = zip.readUInt32LE(end + 12);
  const centralOffset = zip.readUInt32LE(end + 16);
  if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== entries || entries > ACTIONS_BRIDGE_LIMITS.maxArtifactEntries) {
    throw new ActionsBridgeError("artifact_invalid", "The GitHub artifact uses an unsupported ZIP layout.");
  }
  if (centralOffset + centralSize > end) {
    throw new ActionsBridgeError("artifact_invalid", "The GitHub artifact central directory is invalid.");
  }

  const files = new Map();
  let totalUncompressed = 0;
  let cursor = centralOffset;
  for (let index = 0; index < entries; index += 1) {
    if (cursor + 46 > zip.length || zip.readUInt32LE(cursor) !== 0x02014b50) {
      throw new ActionsBridgeError("artifact_invalid", "The GitHub artifact entry table is invalid.");
    }
    const flags = zip.readUInt16LE(cursor + 8);
    const method = zip.readUInt16LE(cursor + 10);
    const compressedSize = zip.readUInt32LE(cursor + 20);
    const uncompressedSize = zip.readUInt32LE(cursor + 24);
    const filenameLength = zip.readUInt16LE(cursor + 28);
    const extraLength = zip.readUInt16LE(cursor + 30);
    const commentLength = zip.readUInt16LE(cursor + 32);
    const localOffset = zip.readUInt32LE(cursor + 42);
    const next = cursor + 46 + filenameLength + extraLength + commentLength;
    if (next > zip.length) throw new ActionsBridgeError("artifact_invalid", "The GitHub artifact entry is truncated.");
    const name = zip.subarray(cursor + 46, cursor + 46 + filenameLength).toString("utf8");
    cursor = next;
    if (!safeZipPath(name) || (flags & 0x1) !== 0 || !new Set([0, 8]).has(method)) {
      throw new ActionsBridgeError("artifact_invalid", "The GitHub artifact contains an unsafe ZIP entry.");
    }
    if (name.endsWith("/")) continue;
    if (uncompressedSize > ACTIONS_BRIDGE_LIMITS.maxArtifactFileBytes) {
      throw new ActionsBridgeError("artifact_too_large", "A GitHub artifact file exceeds the extraction limit.");
    }
    totalUncompressed += uncompressedSize;
    if (totalUncompressed > ACTIONS_BRIDGE_LIMITS.maxArtifactZipBytes) {
      throw new ActionsBridgeError("artifact_too_large", "The expanded GitHub artifact exceeds the extraction limit.");
    }
    if (localOffset + 30 > zip.length || zip.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new ActionsBridgeError("artifact_invalid", "The GitHub artifact local header is invalid.");
    }
    const localNameLength = zip.readUInt16LE(localOffset + 26);
    const localExtraLength = zip.readUInt16LE(localOffset + 28);
    const localFlags = zip.readUInt16LE(localOffset + 6);
    const localMethod = zip.readUInt16LE(localOffset + 8);
    const localName = zip.subarray(localOffset + 30, localOffset + 30 + localNameLength).toString("utf8");
    if (localFlags !== flags || localMethod !== method || localName !== name) {
      throw new ActionsBridgeError("artifact_invalid", "The GitHub artifact local and central headers disagree.");
    }
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    if (dataOffset + compressedSize > zip.length) {
      throw new ActionsBridgeError("artifact_invalid", "The GitHub artifact file data is truncated.");
    }
    const basename = name.split("/").at(-1);
    if (!RESULT_FILES.has(basename)) continue;
    if (files.has(basename)) throw new ActionsBridgeError("artifact_invalid", `The GitHub artifact contains duplicate ${basename} files.`);
    const compressed = zip.subarray(dataOffset, dataOffset + compressedSize);
    let content;
    try {
      content = method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed, { maxOutputLength: ACTIONS_BRIDGE_LIMITS.maxArtifactFileBytes });
    } catch {
      throw new ActionsBridgeError("artifact_invalid", "A GitHub artifact file could not be decompressed safely.");
    }
    if (content.length !== uncompressedSize) {
      throw new ActionsBridgeError("artifact_invalid", "A GitHub artifact file has an invalid expanded size.");
    }
    files.set(basename, content);
  }
  if (!files.has("result.json")) throw new ActionsBridgeError("artifact_invalid", "The GitHub artifact does not contain result.json.");
  return files;
}

export class GitHubActionsBridge {
  constructor({
    token,
    repository = DEFAULT_REPOSITORY,
    workflow = DEFAULT_WORKFLOW,
    ref = DEFAULT_REF,
    fetchImpl = globalThis.fetch,
    now = () => Date.now(),
    sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    idFactory = base64UrlId,
    requestIdFactory = base64UrlId,
    maxActive = 1,
    maxStartsPerMinute = 3,
    maxStartsPerHour = 12,
    minimumPollMs = 2_000,
    resultTtlMs = 15 * 60_000,
    maxRunMs = 22 * 60_000,
    dispatchDiscoveryMs = 2 * 60_000,
    requestTimeoutMs = 15_000,
    artifactTimeoutMs = 30_000,
    allowedRepositories,
  }) {
    if (!String(token || "").trim()) {
      throw new ActionsBridgeError(
        "configuration_required",
        "REPO_RESCUE_GITHUB_TOKEN is required for the platform repository tools.",
      );
    }
    if (typeof fetchImpl !== "function") throw new ActionsBridgeError("configuration_required", "A GitHub HTTP client is unavailable.");
    this.token = String(token).trim();
    this.repository = canonicalRepository(repository);
    this.workflow = configuredWorkflow(workflow);
    this.ref = configuredRef(ref);
    this.fetch = fetchImpl;
    this.now = now;
    this.sleep = sleep;
    this.idFactory = idFactory;
    this.requestIdFactory = requestIdFactory;
    this.maxActive = boundedInteger(maxActive, 1, 1, 16);
    this.maxStartsPerMinute = boundedInteger(maxStartsPerMinute, 3, 1, 60);
    this.maxStartsPerHour = boundedInteger(maxStartsPerHour, 12, 1, 120);
    this.minimumPollMs = boundedInteger(minimumPollMs, 2_000, 250, 10_000);
    this.resultTtlMs = boundedInteger(resultTtlMs, 15 * 60_000, 60_000, 3_600_000);
    this.maxRunMs = boundedInteger(maxRunMs, 22 * 60_000, 60_000, 3_600_000);
    this.dispatchDiscoveryMs = boundedInteger(dispatchDiscoveryMs, 2 * 60_000, 30_000, 10 * 60_000);
    this.requestTimeoutMs = boundedInteger(requestTimeoutMs, 15_000, 50, 60_000);
    this.artifactTimeoutMs = boundedInteger(artifactTimeoutMs, 30_000, 50, 120_000);
    this.allowedRepositories = configuredAllowedRepositories(allowedRepositories);
    this.jobs = new Map();
    this.starts = [];
    this.workflowMetadata = null;
    this.startQueue = Promise.resolve();
  }

  static fromEnvironment(environment = process.env, options = {}) {
    if (!String(environment.REPO_RESCUE_ACTIONS_REF || "").trim()) {
      throw new ActionsBridgeError(
        "configuration_required",
        "REPO_RESCUE_ACTIONS_REF must name the protected bridge branch for platform tools.",
      );
    }
    const allowedRepositories = configuredAllowedRepositories(environment.REPO_RESCUE_ALLOWED_REPOS);
    if (!sameSet(allowedRepositories, new Set(REVIEWED_PLATFORM_REPOSITORIES))) {
      throw new ActionsBridgeError(
        "configuration_required",
        "REPO_RESCUE_ALLOWED_REPOS must exactly match the reviewed bridge workflow allow-list.",
      );
    }
    return new GitHubActionsBridge({
      token: environment.REPO_RESCUE_GITHUB_TOKEN,
      repository: environment.REPO_RESCUE_ACTIONS_REPOSITORY || DEFAULT_REPOSITORY,
      workflow: environment.REPO_RESCUE_ACTIONS_WORKFLOW || DEFAULT_WORKFLOW,
      ref: environment.REPO_RESCUE_ACTIONS_REF,
      maxActive: environment.REPO_RESCUE_ACTIONS_MAX_ACTIVE,
      maxStartsPerMinute: environment.REPO_RESCUE_ACTIONS_STARTS_PER_MINUTE,
      maxStartsPerHour: environment.REPO_RESCUE_ACTIONS_STARTS_PER_HOUR,
      minimumPollMs: environment.REPO_RESCUE_ACTIONS_MIN_POLL_MS,
      resultTtlMs: environment.REPO_RESCUE_ACTIONS_RESULT_TTL_MS,
      maxRunMs: environment.REPO_RESCUE_ACTIONS_MAX_RUN_MS,
      dispatchDiscoveryMs: environment.REPO_RESCUE_ACTIONS_DISPATCH_DISCOVERY_MS,
      requestTimeoutMs: environment.REPO_RESCUE_ACTIONS_REQUEST_TIMEOUT_MS,
      artifactTimeoutMs: environment.REPO_RESCUE_ACTIONS_ARTIFACT_TIMEOUT_MS,
      allowedRepositories: [...allowedRepositories],
      ...options,
    });
  }

  async _request(path, { method = "GET", body, maximumBytes = ACTIONS_BRIDGE_LIMITS.maxJsonResponseBytes } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("GitHub request timeout")), this.requestTimeoutMs);
    try {
      let response;
      try {
        response = await this.fetch(`https://api.github.com${path}`, {
          method,
          redirect: "manual",
          signal: controller.signal,
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${this.token}`,
            "X-GitHub-Api-Version": API_VERSION,
            "User-Agent": "repo-rescue-actions-bridge",
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      } catch (error) {
        throw new ActionsBridgeError("provider_unavailable", safeProviderMessage(error, this.token));
      }
      if (response.status === 204) return { status: 204, value: null };
      let bytes;
      try {
        bytes = await readBoundedBody(response, maximumBytes);
      } catch (error) {
        if (error instanceof ActionsBridgeError) throw error;
        throw new ActionsBridgeError("provider_unavailable", "GitHub interrupted the response stream.", { retryAfterMs: 2_000 });
      }
      if (!response.ok) {
        const rateLimited = response.status === 429
          || response.headers.get("x-ratelimit-remaining") === "0"
          || response.headers.has("retry-after");
        if (rateLimited || response.status >= 500) {
          const seconds = Number.parseInt(response.headers.get("retry-after") || "", 10);
          throw new ActionsBridgeError(
            "provider_unavailable",
            `GitHub Actions is temporarily unavailable (HTTP ${response.status}).`,
            { retryAfterMs: Number.isFinite(seconds) ? Math.min(60_000, Math.max(1_000, seconds * 1_000)) : 2_000 },
          );
        }
        if (response.status === 401 || response.status === 403) {
          throw new ActionsBridgeError("configuration_required", "GitHub rejected the configured Actions credential or permissions.");
        }
        throw new ActionsBridgeError("provider_error", `GitHub Actions returned HTTP ${response.status}.`);
      }
      return { status: response.status, value: bytes.length ? parseJsonBytes(bytes) : null };
    } finally {
      clearTimeout(timer);
    }
  }

  async _downloadArtifact(artifactId) {
    const path = `/repos/${this.repository}/actions/artifacts/${artifactId}/zip`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("GitHub artifact timeout")), this.artifactTimeoutMs);
    try {
      let response;
      try {
        response = await this.fetch(`https://api.github.com${path}`, {
          method: "GET",
          redirect: "manual",
          signal: controller.signal,
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${this.token}`,
            "X-GitHub-Api-Version": API_VERSION,
            "User-Agent": "repo-rescue-actions-bridge",
          },
        });
        if (new Set([301, 302, 303, 307, 308]).has(response.status)) {
          const location = response.headers.get("location");
          let signedUrl;
          try { signedUrl = new URL(location); } catch { throw new Error("invalid redirect"); }
          if (signedUrl.protocol !== "https:") throw new Error("unsafe redirect");
          response = await this.fetch(signedUrl, {
            method: "GET",
            redirect: "error",
            signal: controller.signal,
            headers: { "User-Agent": "repo-rescue-actions-bridge" },
          });
        }
      } catch {
        throw new ActionsBridgeError("provider_unavailable", "The GitHub artifact could not be downloaded safely.");
      }
      if (!response.ok) {
        if (response.status === 429 || response.status >= 500 || response.headers.get("x-ratelimit-remaining") === "0") {
          throw new ActionsBridgeError("provider_unavailable", `GitHub artifact storage is temporarily unavailable (HTTP ${response.status}).`, { retryAfterMs: 2_000 });
        }
        throw new ActionsBridgeError("provider_error", `GitHub artifact download returned HTTP ${response.status}.`);
      }
      try {
        return await readBoundedBody(response, ACTIONS_BRIDGE_LIMITS.maxArtifactZipBytes);
      } catch (error) {
        if (error instanceof ActionsBridgeError) throw error;
        throw new ActionsBridgeError("provider_unavailable", "GitHub interrupted the artifact stream.", { retryAfterMs: 2_000 });
      }
    } finally {
      clearTimeout(timer);
    }
  }

  async _workflow() {
    if (this.workflowMetadata) return this.workflowMetadata;
    const { value } = await this._request(`/repos/${this.repository}/actions/workflows/${encodeURIComponent(this.workflow)}`);
    const expectedPath = /^\d+$/.test(this.workflow) ? null : `.github/workflows/${this.workflow}`;
    if (
      !Number.isSafeInteger(value?.id)
      || value.id <= 0
      || typeof value.path !== "string"
      || !value.path.startsWith(".github/workflows/")
      || (expectedPath !== null && value.path !== expectedPath)
      || value.state !== "active"
    ) {
      throw new ActionsBridgeError("configuration_required", "The configured GitHub Actions workflow is unavailable or inactive.");
    }
    this.workflowMetadata = { id: value.id, path: value.path, name: String(value.name || "") };
    return this.workflowMetadata;
  }

  _purge() {
    const now = this.now();
    for (const [jobId, job] of this.jobs) {
      const discoveryExpired = !job.terminal && job.runId === null && now - job.dispatchedAt >= this.dispatchDiscoveryMs;
      const runExpired = !job.terminal && now - job.dispatchedAt >= this.maxRunMs;
      if (!job.terminal && (discoveryExpired || runExpired)) {
        this._failJob(
          job,
          new ActionsBridgeError(
            "provider_timeout",
            discoveryExpired
              ? "GitHub did not expose the dispatched workflow run before the discovery deadline."
              : "The GitHub Actions repair run exceeded its time limit.",
          ),
        );
      }
      if (job.terminal && now - job.completedAt >= this.resultTtlMs) this.jobs.delete(jobId);
    }
    this.starts = this.starts.filter((timestamp) => now - timestamp < 3_600_000);
  }

  _snapshot(job) {
    const snapshot = {
      job_id: job.jobId,
      operation: job.operation,
      status: job.status,
      terminal: job.terminal,
      poll_tool: "get_repair_job",
    };
    if (job.terminal) snapshot.result = job.result;
    return { ok: true, job: snapshot };
  }

  async start(mode, args) {
    return this._withStartLock(() => this._startLocked(mode, args));
  }

  async _withStartLock(task) {
    let release;
    const previous = this.startQueue;
    this.startQueue = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      return await task();
    } finally {
      release();
    }
  }

  async startVerify(preparationJobId, args) {
    return this._withStartLock(() => this._startVerifyLocked(preparationJobId, args));
  }

  async _startVerifyLocked(preparationJobId, args) {
    this._purge();
    if (!/^[A-Za-z0-9_-]{43}$/.test(String(preparationJobId || ""))) {
      throw new ActionsBridgeError("invalid_request", "preparation_job_id must be the job capability returned by preparation.");
    }
    const preparationJob = this.jobs.get(preparationJobId);
    const preparation = preparationJob?.result?.preparation;
    const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)$/i.exec(String(args?.repo_url || ""));
    const requestedSlug = match?.[1]?.toLowerCase() || null;
    if (
      !preparationJob
      || !preparationJob.terminal
      || preparationJob.mode !== "prepare"
      || preparationJob.status !== "succeeded"
      || preparationJob.result?.ok !== true
      || !preparation
      || preparation.repairable !== true
      || preparation.repository?.slug !== requestedSlug
      || preparation.repository?.commit?.toLowerCase() !== String(args.expected_commit || "").toLowerCase()
      || preparation.baseline_sha256?.toLowerCase() !== String(args.expected_baseline_sha256 || "").toLowerCase()
    ) {
      throw new ActionsBridgeError(
        "preparation_required",
        "Verification requires a live successful repairable preparation job with matching repository, commit, and baseline hash.",
      );
    }
    const verificationFingerprint = sha256(Buffer.from(encodeDispatchPayload("verify", args), "utf8"));
    if (preparationJob.verificationConsumed) {
      const existing = this.jobs.get(preparationJob.verificationJobId);
      if (existing && preparationJob.verificationFingerprint === verificationFingerprint) return this._snapshot(existing);
      throw new ActionsBridgeError("preparation_consumed", "This preparation capability has already been used; start a fresh preparation.");
    }
    const started = await this._startLocked("verify", args);
    preparationJob.verificationConsumed = true;
    preparationJob.verificationFingerprint = verificationFingerprint;
    preparationJob.verificationJobId = started.job.job_id;
    return started;
  }

  async _startLocked(mode, args) {
    this._purge();
    const target = /^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/i.exec(String(args?.repo_url || ""));
    const targetSlug = target?.[1]?.toLowerCase() || null;
    if (!targetSlug || !this.allowedRepositories.has(targetSlug)) {
      throw new ActionsBridgeError("repository_not_allowed", "The requested repository is not in the reviewed execution allow-list.");
    }
    const encodedPayload = encodeDispatchPayload(mode, args);
    const payloadSha256 = sha256(Buffer.from(encodedPayload, "utf8"));
    const active = [...this.jobs.values()].filter((job) => !job.terminal).length;
    if (active >= this.maxActive) throw new ActionsBridgeError("capacity_exceeded", "The Actions repair queue is temporarily full.");
    const now = this.now();
    if (this.starts.filter((timestamp) => now - timestamp < 60_000).length >= this.maxStartsPerMinute) {
      throw new ActionsBridgeError("rate_limited", "The Actions repair per-minute start limit was reached.");
    }
    if (this.starts.length >= this.maxStartsPerHour) {
      throw new ActionsBridgeError("rate_limited", "The Actions repair hourly start limit was reached.");
    }
    const workflow = await this._workflow();
    const jobId = this.idFactory();
    const requestId = this.requestIdFactory();
    if (
      !/^[A-Za-z0-9_-]{43}$/.test(jobId)
      || !/^[A-Za-z0-9_-]{43}$/.test(requestId)
      || jobId === requestId
      || this.jobs.has(jobId)
      || [...this.jobs.values()].some((candidate) => candidate.requestId === requestId)
    ) {
      throw new ActionsBridgeError("internal_error", "A unique repair job ID could not be created.");
    }
    const dispatchedAt = this.now();
    const job = {
      jobId,
      requestId,
      mode,
      operation: mode === "prepare" ? "prepare_github_repair" : "verify_github_patch",
      status: "dispatching",
      terminal: false,
      result: null,
      runId: null,
      headSha: null,
      payloadSha256,
      dispatchedAt,
      lastPollAt: 0,
      completedAt: null,
      firstArtifactMissAt: null,
      nextPollAt: 0,
      pollPromise: null,
    };
    this.jobs.set(jobId, job);
    this.starts.push(dispatchedAt);
    let response;
    try {
      response = await this._request(
        `/repos/${this.repository}/actions/workflows/${workflow.id}/dispatches`,
        {
          method: "POST",
          body: {
            ref: this.ref,
            return_run_details: true,
            inputs: { payload: encodedPayload, request_id: requestId, mode },
          },
        },
      );
    } catch (error) {
      if (error instanceof ActionsBridgeError && error.code === "provider_unavailable") {
        // The server may have accepted the POST before the connection failed.
        // Keep the nonce and discover only that exact run; never redispatch.
        job.status = "dispatch_unknown";
        job.nextPollAt = this.now() + Math.max(this.minimumPollMs, error.retryAfterMs || 0);
        return this._snapshot(job);
      }
      this.jobs.delete(jobId);
      const reservationIndex = this.starts.lastIndexOf(dispatchedAt);
      if (reservationIndex >= 0) this.starts.splice(reservationIndex, 1);
      throw error;
    }
    if (response.status === 200) {
      const runId = Number(response.value?.workflow_run_id);
      if (Number.isSafeInteger(runId) && runId > 0) {
        job.runId = runId;
        job.status = "queued";
      } else {
        job.status = "dispatch_unknown";
      }
    } else if (response.status === 204) {
      job.status = "dispatch_unknown";
    } else {
      job.status = "dispatch_unknown";
    }
    return this._snapshot(job);
  }

  async _discoverLegacyRun(job) {
    const workflow = await this._workflow();
    const created = new Date(job.dispatchedAt - 10_000).toISOString();
    const query = new URLSearchParams({
      event: "workflow_dispatch",
      branch: this.ref,
      per_page: "20",
      created: `>=${created}`,
    });
    const { value } = await this._request(`/repos/${this.repository}/actions/workflows/${workflow.id}/runs?${query}`);
    const expectedTitle = `RepoRescue ${job.requestId} ${job.mode}`;
    const matches = (Array.isArray(value?.workflow_runs) ? value.workflow_runs : []).filter((run) => (
      Number.isSafeInteger(run?.id)
      && run.id > 0
      && run.workflow_id === workflow.id
      && run.event === "workflow_dispatch"
      && run.head_branch === this.ref
      && run.display_title === expectedTitle
      && Date.parse(run.created_at) >= job.dispatchedAt - 10_000
    ));
    if (matches.length > 1) throw new ActionsBridgeError("provider_protocol_error", "Legacy dispatch run discovery was ambiguous.");
    return matches[0]?.id || null;
  }

  _validateRun(job, run) {
    const workflow = this.workflowMetadata;
    const createdAt = Date.parse(run?.created_at);
    const allowedPaths = workflow === null
      ? new Set()
      : new Set([
        workflow.path,
        `${workflow.path}@${this.ref}`,
        `${workflow.path}@refs/heads/${this.ref}`,
      ]);
    if (
      !workflow
      || run?.id !== job.runId
      || run?.workflow_id !== workflow.id
      || run?.event !== "workflow_dispatch"
      || run?.run_attempt !== 1
      || run?.head_branch !== this.ref
      || typeof run?.head_sha !== "string"
      || !/^[0-9a-f]{40}$/i.test(run.head_sha)
      || typeof run?.path !== "string"
      || !allowedPaths.has(run.path)
      || !Number.isFinite(createdAt)
      || createdAt < job.dispatchedAt - 10_000
    ) {
      throw new ActionsBridgeError("provider_protocol_error", "GitHub returned workflow metadata that did not match the dispatched repair job.");
    }
    if (job.headSha !== null && job.headSha !== run.head_sha) {
      throw new ActionsBridgeError("provider_protocol_error", "The workflow run commit changed during polling.");
    }
    job.headSha = run.head_sha;
  }

  async _collectResult(job, run) {
    const expectedName = `repo-rescue-${job.requestId}`;
    const { value } = await this._request(`/repos/${this.repository}/actions/runs/${job.runId}/artifacts?per_page=100`);
    const matches = (Array.isArray(value?.artifacts) ? value.artifacts : []).filter((artifact) => (
      artifact?.name === expectedName
      && artifact?.expired === false
      && Number.isSafeInteger(artifact?.id)
      && artifact.id > 0
      && artifact?.workflow_run?.id === job.runId
      && artifact?.workflow_run?.head_sha === job.headSha
    ));
    if (matches.length === 0) return null;
    if (matches.length !== 1) throw new ActionsBridgeError("artifact_invalid", "The workflow run returned an ambiguous repair artifact.");
    const artifact = matches[0];
    if (!Number.isSafeInteger(artifact.size_in_bytes) || artifact.size_in_bytes < 1 || artifact.size_in_bytes > ACTIONS_BRIDGE_LIMITS.maxArtifactZipBytes) {
      throw new ActionsBridgeError("artifact_too_large", "The workflow artifact declared an invalid or oversized archive.");
    }
    if (!/^sha256:[0-9a-f]{64}$/i.test(String(artifact.digest || ""))) {
      throw new ActionsBridgeError("artifact_invalid", "The workflow artifact did not include a SHA-256 digest.");
    }
    const zip = await this._downloadArtifact(artifact.id);
    const expectedDigest = artifact.digest.slice("sha256:".length).toLowerCase();
    if (sha256(zip) !== expectedDigest) throw new ActionsBridgeError("artifact_invalid", "The workflow artifact digest did not match its archive.");
    const files = extractBridgeArtifact(zip);
    if (files.get("result.json").length > ACTIONS_BRIDGE_LIMITS.maxJsonResponseBytes) {
      throw new ActionsBridgeError("provider_response_too_large", "result.json exceeds the platform response limit.");
    }
    const result = parseJsonBytes(files.get("result.json"));
    if (
      result?.request_id !== job.requestId
      || result?.mode !== job.mode
      || result?.payload_sha256 !== job.payloadSha256
      || String(result?.github_run_id) !== String(job.runId)
      || result?.github_sha !== job.headSha
      || typeof result?.result !== "object"
      || result.result === null
      || Array.isArray(result.result)
      || typeof result.result.ok !== "boolean"
    ) {
      throw new ActionsBridgeError("artifact_invalid", "result.json was not bound to the dispatched repair job.");
    }
    let artifactContents = null;
    if (job.mode === "prepare") {
      if (files.size !== 1) throw new ActionsBridgeError("artifact_invalid", "A preparation artifact may contain only result.json.");
    } else if (result.result.ok === true) {
      const required = ["repair.patch", "evidence.json", "report.md"];
      if (!required.every((name) => files.has(name))) {
        throw new ActionsBridgeError("artifact_invalid", "A successful verification artifact is missing patch or evidence files.");
      }
      const patchText = decodeUtf8(files.get("repair.patch"), "repair.patch");
      const evidenceText = decodeUtf8(files.get("evidence.json"), "evidence.json");
      const reportText = decodeUtf8(files.get("report.md"), "report.md");
      let evidence;
      try { evidence = JSON.parse(evidenceText); } catch {
        throw new ActionsBridgeError("artifact_invalid", "evidence.json is not valid JSON.");
      }
      const repair = result.result.repair;
      if (
        !repair
        || typeof repair !== "object"
        || Array.isArray(repair)
        || typeof repair.verified_repair !== "boolean"
        || evidence?.run_id !== repair.run_id
        || evidence?.status !== repair.status
        || evidence?.verified_repair !== repair.verified_repair
        || evidence?.repository?.slug !== repair?.repository?.slug
        || evidence?.repository?.commit !== repair?.repository?.commit
        || evidence?.baseline?.command !== repair?.baseline?.command
        || evidence?.final_verification?.command !== repair?.final_verification?.command
        || evidence?.patch_sha256 !== repair.patch_sha256
        || sha256(files.get("repair.patch")) !== repair.patch_sha256
        || (repair.verified_repair === true && (repair.status !== "verified_repair" || patchText.length === 0))
        || !reportText.includes(String(repair.run_id))
      ) {
        throw new ActionsBridgeError("artifact_invalid", "The repair result and evidence bundle do not describe the same verified run.");
      }
      artifactContents = {
        patch: patchText,
        evidence: evidenceText,
        report: reportText,
      };
    }
    const publicResult = {
      ...result.result,
      github_actions: {
        repository: this.repository,
        workflow_run_id: job.runId,
        head_sha: job.headSha,
        artifact_id: artifact.id,
        artifact_name: artifact.name,
        artifact_digest: artifact.digest.toLowerCase(),
        html_url: typeof run.html_url === "string" ? run.html_url : null,
        files: Object.fromEntries([...files.entries()].map(([name, content]) => [name, { bytes: content.length, sha256: sha256(content) }])),
        ...(artifactContents === null ? {} : { artifact_contents: artifactContents }),
      },
    };
    if (byteLengthJson(publicResult) > ACTIONS_BRIDGE_LIMITS.maxJsonResponseBytes) {
      throw new ActionsBridgeError("provider_response_too_large", "The repair result exceeds the platform response limit.");
    }
    return publicResult;
  }

  async _pollOnce(job) {
    if (job.terminal) return;
    job.nextPollAt = 0;
    if (this.now() - job.dispatchedAt > this.maxRunMs) {
      throw new ActionsBridgeError("provider_timeout", "The GitHub Actions repair run exceeded its time limit.");
    }
    if (job.runId === null) {
      job.runId = await this._discoverLegacyRun(job);
      if (job.runId === null) {
        job.status = "dispatch_unknown";
        return;
      }
    }
    const { value: run } = await this._request(`/repos/${this.repository}/actions/runs/${job.runId}`);
    this._validateRun(job, run);
    const knownStatuses = new Set(["queued", "requested", "waiting", "pending", "in_progress", TERMINAL_RUN_STATUS]);
    if (!knownStatuses.has(run.status)) {
      throw new ActionsBridgeError("provider_protocol_error", "GitHub returned an unknown workflow run status.");
    }
    if (run.status !== TERMINAL_RUN_STATUS) {
      job.status = run.status === "queued" || run.status === "requested" || run.status === "waiting" || run.status === "pending"
        ? "queued"
        : "running";
      return;
    }
    const result = await this._collectResult(job, run);
    if (result === null) {
      if (job.firstArtifactMissAt === null) job.firstArtifactMissAt = this.now();
      if (this.now() - job.firstArtifactMissAt < 45_000) {
        job.status = "collecting_artifact";
        job.nextPollAt = this.now() + this.minimumPollMs;
        return;
      }
      throw new ActionsBridgeError("artifact_unavailable", "The completed workflow did not publish its bound result artifact.");
    }
    const operationSucceeded = result.ok === true;
    const workflowSucceeded = run.conclusion === "success";
    if (operationSucceeded !== workflowSucceeded) {
      throw new ActionsBridgeError("provider_protocol_error", "The workflow conclusion and result artifact were inconsistent.");
    }
    job.result = result;
    job.status = operationSucceeded ? "succeeded" : "failed";
    job.terminal = true;
    job.completedAt = this.now();
  }

  _failJob(job, error) {
    job.result = {
      ok: false,
      status: error instanceof ActionsBridgeError ? error.code : "provider_error",
      error_type: error instanceof ActionsBridgeError ? error.name : "InternalError",
      message: safeProviderMessage(error, this.token),
    };
    job.status = "failed";
    job.terminal = true;
    job.completedAt = this.now();
  }

  async _pollWithLock(job) {
    if (job.pollPromise) return job.pollPromise;
    job.pollPromise = (async () => {
      try {
        job.lastPollAt = this.now();
        await this._pollOnce(job);
      } catch (error) {
        if (error instanceof ActionsBridgeError && error.code === "provider_unavailable") {
          job.status = "poll_deferred";
          job.nextPollAt = this.now() + Math.max(this.minimumPollMs, error.retryAfterMs || 0);
        } else {
          this._failJob(job, error);
        }
      } finally {
        job.pollPromise = null;
      }
    })();
    return job.pollPromise;
  }

  async get(jobId, waitSeconds = 0) {
    this._purge();
    if (!/^[A-Za-z0-9_-]{43}$/.test(String(jobId || ""))) {
      throw new ActionsBridgeError("unknown_job", "Unknown or expired repair job.");
    }
    const wait = Number(waitSeconds);
    if (!Number.isFinite(wait) || wait < 0 || wait > ACTIONS_BRIDGE_LIMITS.maxWaitSeconds) {
      throw new ActionsBridgeError("invalid_request", `wait_seconds must be between 0 and ${ACTIONS_BRIDGE_LIMITS.maxWaitSeconds}.`);
    }
    const job = this.jobs.get(jobId);
    if (!job) throw new ActionsBridgeError("unknown_job", "Unknown or expired repair job.");
    const deadline = this.now() + wait * 1_000;
    do {
      if (job.terminal) break;
      const untilAllowed = Math.max(
        0,
        this.minimumPollMs - (this.now() - job.lastPollAt),
        job.nextPollAt - this.now(),
      );
      if (untilAllowed > 0) {
        if (wait === 0 || this.now() + untilAllowed > deadline) break;
        await this.sleep(untilAllowed);
      }
      await this._pollWithLock(job);
      if (job.terminal || wait === 0 || this.now() >= deadline) break;
      const remaining = deadline - this.now();
      if (remaining <= 0) break;
    } while (true);
    return this._snapshot(job);
  }
}

// Kept as a tiny testable decoder companion to the Python workflow runner.
export function decodeDispatchPayload(encoded) {
  if (typeof encoded !== "string" || encoded.length > ACTIONS_BRIDGE_LIMITS.maxDispatchPayloadChars) {
    throw new ActionsBridgeError("payload_too_large", "The workflow payload exceeds its encoded limit.");
  }
  const bytes = gunzipSync(Buffer.from(encoded, "base64"), { maxOutputLength: ACTIONS_BRIDGE_LIMITS.maxDecodedPayloadBytes });
  return JSON.parse(bytes.toString("utf8"));
}
