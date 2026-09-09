#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

// Generate schemas from the same reviewed platform process, without inheriting
// any credential or host override. Output files contain no Service token.
const names = ["rescue_python_snippet", "start_prepare_github_repair", "get_repair_job", "start_verify_github_patch"];
const titles = ["rescue_snippet", "rescue_prepare", "rescue_poll", "rescue_verify"];
const root = fileURLToPath(new URL("../", import.meta.url));
const environment = {};
for (const name of ["PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE"]) {
  if (process.env[name] !== undefined) environment[name] = process.env[name];
}
const child = spawn(process.execPath, [join(root, "platform-entry.mjs")], {
  env: environment, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
});
let buffer = "";
try {
  const tools = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Tool discovery timed out")), 10000);
    child.on("error", reject);
    child.on("exit", () => { clearTimeout(timer); reject(new Error("Tool process exited")); });
    child.stderr.resume();
    child.stdout.on("data", chunk => {
      buffer += chunk.toString("utf8");
      if (buffer.length > 1024 * 1024) { clearTimeout(timer); reject(new Error("Oversized discovery")); return; }
      while (buffer.includes("\n")) {
        const index = buffer.indexOf("\n");
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        try {
          const message = JSON.parse(line);
          if (message.id === 1) {
            if (message.error) throw new Error("Initialize failed");
            child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
            child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
          } else if (message.id === 2) {
            clearTimeout(timer);
            resolve(message.result?.tools);
          }
        } catch (error) { clearTimeout(timer); reject(error); }
      }
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
      protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "contract-builder", version: "1" },
    } }) + "\n");
  });
  if (!Array.isArray(tools) || tools.length !== 4 || !names.every((name, i) => tools[i].name === name)) {
    throw new Error("Unexpected platform tools");
  }
  const output = join(root, "dist", "http-plugins");
  mkdirSync(output, { recursive: true });
  tools.forEach((tool, index) => {
    const contract = {
      openapi: "3.0.3", info: { title: titles[index], version: "0.4.1", description: tool.description },
      servers: [{ url: "https://reporescue-mcp-production.up.railway.app" }],
      paths: { [`/api/tools/${tool.name}`]: { post: {
        operationId: titles[index], summary: tool.description,
        security: [{ bearerAuth: [] }],
        requestBody: { required: true, content: { "application/json": { schema: tool.inputSchema } } },
        responses: { "200": { description: "Original MCP evidence. HTTP 200 does not imply repair success.", content: {
          "application/json": { schema: { type: "object", required: ["is_error", "result_json"], properties: {
            is_error: { type: "boolean", description: "MCP protocol/tool error indicator, not repair verification status" },
            result_json: { type: "string", description: "Complete original MCP result JSON. Parse content[0].text for tool evidence; only its verification fields justify success." },
          } } },
        } } },
      } } },
      components: { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } } },
    };
    writeFileSync(join(output, `${titles[index]}.json`), JSON.stringify(contract, null, 2) + "\n", "utf8");
  });
  process.stdout.write(JSON.stringify({ output, count: tools.length, credentials_included: false }) + "\n");
} finally { child.kill(); }
