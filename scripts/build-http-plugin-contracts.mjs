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
    // HTTP-only compatibility for editors that render nested objects as React
    // children. The original MCP schema and runtime array validation stay intact.
    const inputSchema = structuredClone(tool.inputSchema);
    if (tool.name === "rescue_python_snippet") {
      inputSchema.properties.test_cases = {
        type: "string",
        description: "JSON-encoded array of 1 to 4 objects. Each object must contain name (string) and expected_stdout (string) from the user's requirement or an independent test oracle. Encode newline characters as JSON escapes. Do not invent or default the expected output; no oracle means no verified repair.",
      };
    } else if (tool.name === "start_verify_github_patch") {
      inputSchema.properties.changes = {
        type: "string",
        description: "JSON-encoded array of 1 to 3 objects, each with path (existing non-test file path) and content (the complete replacement file, at most 12000 characters). Preserve indentation and encode newlines as JSON escapes. Do not modify tests or include extra fields.",
      };
    }
    const contract = {
      openapi: "3.0.3", info: { title: titles[index], version: "0.4.1", description: tool.description },
      servers: [{ url: "https://reporescue-mcp-production.up.railway.app" }],
      paths: { [`/api/tools/${tool.name}`]: { post: {
        operationId: titles[index], summary: tool.description,
        security: [{ bearerAuth: [] }],
        requestBody: { required: true, content: { "application/json": { schema: inputSchema } } },
        responses: { "200": { description: "Original MCP evidence. HTTP 200 does not imply repair success.", content: {
          "application/json": { schema: { type: "object", required: ["is_error", "result_json", "receipt_url"], properties: {
            is_error: { type: "boolean", description: "MCP protocol/tool error indicator, not repair verification status" },
            result_json: { type: "string", description: "Complete original MCP result fields plus a gateway receipt_url mirror. Existing MCP content is unchanged. Parse content[0].text for tool evidence; only its verification fields justify success." },
            receipt_url: { type: "string", description: "Read-only original artifact receipt. Non-empty only for a successfully verified terminal repository repair. Return this exact URL to the user instead of retyping patches or hashes; empty means no receipt is available." },
          } } },
        } } },
      } } },
      components: { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } } },
    };
    writeFileSync(join(output, `${titles[index]}.json`), JSON.stringify(contract, null, 2) + "\n", "utf8");
  });
  process.stdout.write(JSON.stringify({ output, count: tools.length, credentials_included: false }) + "\n");
} finally { child.kill(); }
