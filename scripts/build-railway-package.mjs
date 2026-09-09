#!/usr/bin/env node
import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// An allow-listed build context keeps the Python Dockerfile and local files
// out of this Node deployment even if the host ignores dockerfilePath.
const root = fileURLToPath(new URL("../", import.meta.url));
const output = join(root, "dist");
mkdirSync(output, { recursive: true });
const stage = mkdtempSync(join(output, "railway-"));
for (const name of [
  "package.json", "package-lock.json", "http-sse-server.mjs", "platform-entry.mjs",
  "stdio-server.mjs", "actions-bridge.mjs", "snippet-pair.mjs",
  "snippet-worker-env.mjs", "snippet-worker.mjs", "railway.toml", "Dockerfile.railway",
]) copyFileSync(join(root, name), join(stage, name));
copyFileSync(join(root, "Dockerfile.railway"), join(stage, "Dockerfile"));
process.stdout.write(`${stage}\n`);
