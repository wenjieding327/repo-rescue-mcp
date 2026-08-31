#!/usr/bin/env node

import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");
const manifestPath = join(repositoryRoot, "package.xfyun.json");
const shrinkwrapPath = join(repositoryRoot, "npm-shrinkwrap.xfyun.json");
const outputDirectory = join(repositoryRoot, "dist", "xfyun");
const runtimeFiles = Object.freeze([
  "README.md",
  "actions-bridge.mjs",
  "platform-entry.mjs",
  "snippet-pair.mjs",
  "snippet-worker-env.mjs",
  "snippet-worker.mjs",
  "stdio-server.mjs",
]);
const expectedPackedFiles = Object.freeze([...runtimeFiles, "npm-shrinkwrap.json", "package.json"].sort());

function runNpmPack(stagingDirectory, outputDirectory) {
  const args = ["pack", "--json", "--ignore-scripts", "--pack-destination", outputDirectory];
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error("Run this builder through `npm run pack:xfyun` so npm_execpath is fixed.");
  const packed = spawnSync(process.execPath, [npmCli, ...args], {
    cwd: stagingDirectory,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    shell: false,
    timeout: 60_000,
  });
  if (packed.error || packed.status !== 0) throw new Error(packed.error?.message || packed.stderr || packed.stdout || "npm pack failed");
  return JSON.parse(packed.stdout)[0];
}

async function main() {
  if (process.argv.length !== 2) throw new Error("The XFYun package output directory is fixed; arguments are not accepted.");
  const rootManifest = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
  const rootLock = JSON.parse(await readFile(join(repositoryRoot, "package-lock.json"), "utf8"));
  const xfyunManifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const xfyunShrinkwrap = JSON.parse(await readFile(shrinkwrapPath, "utf8"));
  const expectedManifestKeys = ["bin", "dependencies", "description", "engines", "files", "name", "private", "type", "version"];
  if (JSON.stringify(Object.keys(xfyunManifest).sort()) !== JSON.stringify(expectedManifestKeys)) {
    throw new Error("XFYun package manifest contains an unreviewed field or lifecycle script.");
  }
  if (xfyunManifest.name !== "repo-rescue-mcp-platform" || xfyunManifest.private !== true || xfyunManifest.type !== "module") {
    throw new Error("XFYun package identity and module boundary must remain fixed.");
  }
  if (JSON.stringify(xfyunManifest.engines) !== JSON.stringify(rootManifest.engines)) {
    throw new Error("XFYun package Node engine requirement must match the reviewed core package.");
  }
  if (!new RegExp(`^${rootManifest.version.replaceAll(".", "\\.")}-xfyun\\.[1-9][0-9]*$`).test(xfyunManifest.version)) {
    throw new Error("XFYun package version must be a numbered prerelease of the reviewed core version.");
  }
  if (xfyunManifest.bin !== "./platform-entry.mjs") throw new Error("XFYun package must expose one default platform bin.");
  if (JSON.stringify(xfyunManifest.dependencies) !== JSON.stringify(rootManifest.dependencies)) {
    throw new Error("XFYun and root package runtime dependencies must match.");
  }
  if (JSON.stringify([...xfyunManifest.files].sort()) !== JSON.stringify([...runtimeFiles, "npm-shrinkwrap.json"].sort())) {
    throw new Error("XFYun package file allow-list does not match the reviewed runtime.");
  }
  if (xfyunShrinkwrap.name !== xfyunManifest.name || xfyunShrinkwrap.version !== xfyunManifest.version) {
    throw new Error("XFYun shrinkwrap identity must match its package manifest.");
  }
  if (JSON.stringify(xfyunShrinkwrap.packages?.[""]?.dependencies) !== JSON.stringify(xfyunManifest.dependencies)) {
    throw new Error("XFYun shrinkwrap root dependencies must match its package manifest.");
  }
  if (JSON.stringify(xfyunShrinkwrap.packages?.[""]?.bin) !== JSON.stringify({ "repo-rescue-mcp-platform": "platform-entry.mjs" })) {
    throw new Error("XFYun shrinkwrap must contain only the platform bin.");
  }
  const rootRuntimePackages = Object.fromEntries(Object.entries(rootLock.packages || {}).filter(([path]) => path !== ""));
  const xfyunRuntimePackages = Object.fromEntries(Object.entries(xfyunShrinkwrap.packages || {}).filter(([path]) => path !== ""));
  if (JSON.stringify(xfyunRuntimePackages) !== JSON.stringify(rootRuntimePackages)) {
    throw new Error("XFYun shrinkwrap runtime dependency tree must match the reviewed root lockfile.");
  }

  await mkdir(outputDirectory, { recursive: true });
  const stagingDirectory = await mkdtemp(join(tmpdir(), "repo-rescue-xfyun-"));
  try {
    await writeFile(join(stagingDirectory, "package.json"), `${JSON.stringify(xfyunManifest, null, 2)}\n`, "utf8");
    await copyFile(shrinkwrapPath, join(stagingDirectory, "npm-shrinkwrap.json"));
    for (const path of runtimeFiles) {
      await copyFile(join(repositoryRoot, path), join(stagingDirectory, basename(path)));
    }
    const packed = runNpmPack(stagingDirectory, outputDirectory);
    const packedFiles = packed.files.map((file) => file.path).sort();
    if (JSON.stringify(packedFiles) !== JSON.stringify(expectedPackedFiles)) {
      throw new Error(`Unexpected packed files: ${packedFiles.join(", ")}`);
    }
    const archivePath = join(outputDirectory, packed.filename);
    const sha256 = createHash("sha256").update(await readFile(archivePath)).digest("hex");
    process.stdout.write(`${JSON.stringify({
      archive: archivePath,
      filename: packed.filename,
      size: packed.size,
      shasum: packed.shasum,
      integrity: packed.integrity,
      sha256,
      files: packedFiles,
      bin: xfyunManifest.bin,
    }, null, 2)}\n`);
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true });
  }
}

await main();
