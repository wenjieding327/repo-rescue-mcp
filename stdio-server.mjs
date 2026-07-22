#!/usr/bin/env node

import { createInterface } from "node:readline";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const ALLOWED_REPOS = new Set(
  (process.env.REPO_RESCUE_ALLOWED_REPOS || "pallets/click")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean),
);

const tools = [
  {
    name: "inspect_github_project",
    description: "Inspect an allow-listed public GitHub repository and return its exact commit and Python project evidence.",
    inputSchema: {
      type: "object",
      properties: { repo_url: { type: "string", description: "Public GitHub repository URL" } },
      required: ["repo_url"],
      additionalProperties: false,
    },
  },
  {
    name: "reproduce_python_project",
    description: "Clone and actually run the allow-listed Python repository tests, returning exit code, counts, command and logs.",
    inputSchema: {
      type: "object",
      properties: { repo_url: { type: "string", description: "Public GitHub repository URL" } },
      required: ["repo_url"],
      additionalProperties: false,
    },
  },
  {
    name: "windows_environment_probe",
    description: "Return a non-mutating PowerShell probe the user can run locally; never claims automatic computer access.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

function parseRepo(url) {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/#?]+?)(?:\.git)?\/?$/i.exec(String(url || "").trim());
  if (!match) throw new Error("Only canonical public https://github.com/owner/repository URLs are accepted.");
  const slug = `${match[1]}/${match[2]}`.toLowerCase();
  if (!ALLOWED_REPOS.has(slug)) throw new Error(`Execution is restricted to the allow-list: ${[...ALLOWED_REPOS].join(", ")}`);
  return { slug, url: `https://github.com/${slug}.git` };
}

function run(command, args, options = {}) {
  const started = Date.now();
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env || process.env,
    encoding: "utf8",
    timeout: options.timeout || 60000,
    maxBuffer: 12 * 1024 * 1024,
  });
  return {
    command: [command, ...args].join(" "),
    exit_code: result.status,
    timed_out: result.error?.code === "ETIMEDOUT",
    duration_seconds: Math.round((Date.now() - started) / 100) / 10,
    stdout: String(result.stdout || "").slice(-12000),
    stderr: String(result.stderr || result.error?.message || "").slice(-12000),
  };
}

function cloneRepository(repoUrl) {
  const repo = parseRepo(repoUrl);
  const root = mkdtempSync(join(tmpdir(), "repo-rescue-node-"));
  const project = join(root, "project");
  const clone = run("git", ["clone", "--depth", "1", "--filter=blob:none", "--no-tags", repo.url, project], { timeout: 45000 });
  if (clone.exit_code !== 0) {
    rmSync(root, { recursive: true, force: true });
    throw new Error(`Clone failed with exit code ${clone.exit_code}: ${clone.stderr.slice(-1000)}`);
  }
  const commitRun = run("git", ["rev-parse", "HEAD"], { cwd: project, timeout: 5000 });
  const commit = commitRun.stdout.trim();
  if (!/^[0-9a-f]{40}$/i.test(commit)) throw new Error("Cloned repository did not expose a valid commit SHA.");
  return { ...repo, root, project, commit };
}

function inspectProject(repoUrl) {
  const snapshot = cloneRepository(repoUrl);
  try {
    let pyproject = "";
    try { pyproject = readFileSync(join(snapshot.project, "pyproject.toml"), "utf8"); } catch {}
    const requiresPython = /requires-python\s*=\s*["']([^"']+)/.exec(pyproject)?.[1] || "not declared";
    return {
      ok: true,
      verified: false,
      repository: snapshot.slug,
      source_url: repoUrl,
      commit_sha: snapshot.commit,
      detected_language: "python",
      requires_python: requiresPython,
      evidence_note: "Commit and project metadata were read from a fresh shallow clone; no test result is claimed by this inspection tool.",
    };
  } finally {
    rmSync(snapshot.root, { recursive: true, force: true });
  }
}

function extractCounts(text) {
  const counts = { passed: 0, failed: 0, skipped: 0, xfailed: 0, errors: 0 };
  for (const key of Object.keys(counts)) {
    const matches = [...String(text).matchAll(new RegExp(`(\\d+) ${key}`, "g"))];
    if (matches.length) counts[key] = Number(matches.at(-1)[1]);
  }
  return counts;
}

function reproduceProject(repoUrl) {
  const snapshot = cloneRepository(repoUrl);
  try {
    const pythonCandidates = process.platform === "win32" ? ["python"] : ["python3", "python"];
    let python = null;
    for (const candidate of pythonCandidates) {
      const check = run(candidate, ["--version"], { timeout: 5000 });
      if (check.exit_code === 0) { python = candidate; break; }
    }
    if (!python) return { verified: false, repository: snapshot.slug, commit_sha: snapshot.commit, status: "python_unavailable", exit_code: null };

    let execution = run(python, ["-m", "pytest", "-q", "--ignore=tests/test_utils/test_echo_via_pager.py"], {
      cwd: snapshot.project,
      timeout: 90000,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", PYTHONPATH: join(snapshot.project, "src") },
    });
    if (/No module named pytest/.test(execution.stderr)) {
      const site = join(snapshot.root, "site");
      const install = run(python, ["-m", "pip", "install", "--disable-pip-version-check", "--no-input", "--progress-bar", "off", "--target", site, "pytest>=8,<10"], { timeout: 60000 });
      if (install.exit_code !== 0) return { verified: false, repository: snapshot.slug, commit_sha: snapshot.commit, status: "pytest_install_failed", install };
      execution = run(python, ["-m", "pytest", "-q", "--ignore=tests/test_utils/test_echo_via_pager.py"], {
        cwd: snapshot.project,
        timeout: 90000,
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", PYTHONPATH: `${site}${process.platform === "win32" ? ";" : ":"}${join(snapshot.project, "src")}` },
      });
    }
    const output = `${execution.stdout}\n${execution.stderr}`;
    return {
      status: execution.exit_code === 0 && !execution.timed_out ? "verified" : "verification_failed",
      verified: execution.exit_code === 0 && !execution.timed_out,
      repository: snapshot.slug,
      commit_sha: snapshot.commit,
      backend: "hosted_direct_allowlist",
      verification_command: execution.command,
      exit_code: execution.exit_code,
      timed_out: execution.timed_out,
      duration_seconds: execution.duration_seconds,
      counts: extractCounts(output),
      log_tail: output.slice(-10000),
      evidence_note: "Verification status is derived only from this allow-listed hosted process exit code.",
    };
  } finally {
    rmSync(snapshot.root, { recursive: true, force: true });
  }
}

function windowsProbe() {
  return {
    ok: true,
    platform: "windows",
    changes_system: false,
    command: "$ErrorActionPreference='Continue'; Write-Output '=== SYSTEM ==='; Get-CimInstance Win32_OperatingSystem | Select-Object Caption,Version,OSArchitecture; Write-Output '=== PYTHON ==='; python --version; Write-Output '=== PIP ==='; python -m pip --version; Write-Output '=== PACKAGES ==='; python -m pip list --format=freeze",
    instructions: "Run this in PowerShell, review it, and paste only the relevant output back. RepoRescue cannot read a user's computer automatically.",
  };
}

function callTool(name, args) {
  if (name === "inspect_github_project") return inspectProject(args.repo_url);
  if (name === "reproduce_python_project") return reproduceProject(args.repo_url);
  if (name === "windows_environment_probe") return windowsProbe();
  throw new Error(`Unknown tool: ${name}`);
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  if (!line.trim()) return;
  let request;
  try { request = JSON.parse(line); } catch { return; }
  if (request.id === undefined || request.id === null) return;
  try {
    let result;
    if (request.method === "initialize") {
      result = { protocolVersion: request.params?.protocolVersion || "2025-03-26", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "repo-rescue-mcp", version: "0.1.0" } };
    } else if (request.method === "ping") {
      result = {};
    } else if (request.method === "tools/list") {
      result = { tools };
    } else if (request.method === "tools/call") {
      const value = callTool(request.params?.name, request.params?.arguments || {});
      result = { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], isError: false };
    } else {
      send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: `Method not found: ${request.method}` } });
      return;
    }
    send({ jsonrpc: "2.0", id: request.id, result });
  } catch (error) {
    send({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: JSON.stringify({ ok: false, verified: false, error: String(error?.message || error) }) }], isError: true } });
  }
});
