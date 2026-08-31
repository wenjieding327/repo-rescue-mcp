#!/usr/bin/env node

import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");
const rootManifest = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
const manifest = JSON.parse(await readFile(join(repositoryRoot, "package.xfyun.json"), "utf8"));
const archiveName = `${manifest.name}-${manifest.version}.tgz`;
const archivePath = join(repositoryRoot, "dist", "xfyun", archiveName);
const archiveSpec = `./dist/xfyun/${archiveName}`;
const expectedEntries = [
  "package/README.md",
  "package/actions-bridge.mjs",
  "package/npm-shrinkwrap.json",
  "package/package.json",
  "package/platform-entry.mjs",
  "package/snippet-pair.mjs",
  "package/snippet-worker-env.mjs",
  "package/snippet-worker.mjs",
  "package/stdio-server.mjs",
].sort();
const expectedTools = [
  "get_repair_job",
  "rescue_python_snippet",
  "start_prepare_github_repair",
  "start_verify_github_patch",
];

await access(archivePath);
const listed = spawnSync("tar", ["-tf", archivePath], { encoding: "utf8", shell: false, timeout: 10_000 });
if (listed.error || listed.status !== 0) throw new Error(listed.error?.message || listed.stderr || "Unable to inspect the XFYun package archive.");
const entries = listed.stdout.split(/\r?\n/).filter(Boolean).sort();
if (JSON.stringify(entries) !== JSON.stringify(expectedEntries)) {
  throw new Error(`Unexpected XFYun archive entries: ${entries.join(", ")}`);
}

const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("Run this verifier through `npm run verify:xfyun` so npm_execpath is fixed.");
const npxCli = join(dirname(npmCli), "npx-cli.js");
await access(npxCli);
const environment = { ...process.env };
for (const name of ["REPO_RESCUE_GITHUB_TOKEN", "GITHUB_TOKEN", "GH_TOKEN", "NPM_TOKEN", "NODE_AUTH_TOKEN"]) {
  delete environment[name];
}
Object.assign(environment, {
  REPO_RESCUE_NODE_TOOLSET: "full",
  REPO_RESCUE_ACTIONS_REPOSITORY: "attacker/control",
  REPO_RESCUE_ACTIONS_WORKFLOW: "attacker.yml",
  REPO_RESCUE_ACTIONS_REF: "attacker",
  REPO_RESCUE_ALLOWED_REPOS: "attacker/example",
});
const requests = [
  { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "xfyun-package-verifier", version: "1" } } },
  { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
  { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "inspect_github_project", arguments: { repo_url: "https://github.com/wenjieding327/repo-rescue-mcp" } } },
  { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "start_prepare_github_repair", arguments: { repo_url: "https://github.com/wenjieding327/repo-rescue-mcp" } } },
];
const invoked = spawnSync(process.execPath, [npxCli, "-y", archiveSpec], {
  cwd: repositoryRoot,
  env: environment,
  input: `${requests.map((request) => JSON.stringify(request)).join("\n")}\n`,
  encoding: "utf8",
  maxBuffer: 4 * 1024 * 1024,
  shell: false,
  timeout: 120_000,
});
if (invoked.error || invoked.status !== 0) throw new Error(invoked.error?.message || invoked.stderr || invoked.stdout || "XFYun package execution failed.");
const responses = invoked.stdout.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
const byId = new Map(responses.map((response) => [response.id, response]));
if (byId.get(1)?.result?.serverInfo?.version !== rootManifest.version) throw new Error("Unexpected MCP core server version.");
const toolNames = (byId.get(2)?.result?.tools || []).map((tool) => tool.name).sort();
if (JSON.stringify(toolNames) !== JSON.stringify(expectedTools)) throw new Error(`Unexpected MCP tools: ${toolNames.join(", ")}`);
const hiddenResult = JSON.parse(byId.get(3)?.result?.content?.[0]?.text || "null");
if (hiddenResult?.status !== "tool_unavailable" || byId.get(3)?.result?.isError !== true) {
  throw new Error("A hidden tool was not rejected by the packed platform entrypoint.");
}
const missingToken = JSON.parse(byId.get(4)?.result?.content?.[0]?.text || "null");
if (missingToken?.status !== "configuration_required") throw new Error("The packed platform entrypoint did not fail closed without a token.");

const archiveSha256 = createHash("sha256").update(await readFile(archivePath)).digest("hex");
process.stdout.write(`${JSON.stringify({ archive: archivePath, sha256: archiveSha256, entries, tools: toolNames, hidden_tool: hiddenResult.status, no_token: missingToken.status }, null, 2)}\n`);
