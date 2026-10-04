#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

// Generate schemas from the same reviewed platform process, without inheriting
// any credential or host override. Output files contain no Service token.
const names = ["rescue_python_snippet", "start_prepare_github_repair", "get_repair_job", "start_verify_github_patch"];
const titles = ["rescue_snippet", "rescue_prepare", "rescue_poll", "rescue_verify"];
const executeDescription = "Independent execution node for frozen workflow data, not an Agent-selected tool. Send one Body field request_json containing a strict JSON object. snippet executes only rescue_python_snippet; github polls only an existing job with wait_seconds=15; advice executes nothing. It cannot dispatch prepare/verify jobs. Use the same independent gateway Bearer authentication via Service > Header, Authorization; never place credentials in Body, Query, defaults, examples or prompts. Local contract generation is not deployment, platform acceptance or publication evidence.";
const executeRequestDescription = "Bind directly from the candidate-binding code node's key0 (request_json), never from Agent output or REASONING_CONTENT. No Markdown fences or extra/duplicate fields. snippet requires exactly route=snippet, original_code (1-12000 chars), candidate_code (1-12000 chars), test_cases (native JSON array of at most 4 name/stdin/expected_stdout objects, not another array string). Each expected_stdout is the user's independently supplied complete program stdout; omit it when unknown, and never invent an oracle. github requires exactly route=github, repo_url (canonical https://github.com/owner/repo), job_id (43 ASCII URL-safe chars), request_started_at (timezone-bearing ISO timestamp); it only polls, cannot start work, and the independent report gate must bind repository/time to the actual result. advice requires exactly route=advice. request_json is JSON text inside the outer JSON Body object, not an object value or trusted verification report.";
const executeInstructions = `RepoRescue rescue_execute: local import candidate, not deployed or accepted.

Generate: node scripts/build-http-plugin-contracts.mjs
Import: dist/http-plugins/rescue_execute.json
Method/path: POST /xfyun/execute on the fixed gateway origin.
Authentication: use the existing dedicated gateway credential in Service > Header;
parameter name Authorization, Bearer scheme. Never put credentials in request
defaults, prompts, descriptions, URLs, exported contracts or screenshots.

There is exactly one required top-level input, request_json, type String. Set its
location to Body. Remove importer-created defaults/examples and verify persisted
configuration. Bind it directly to candidate-binding key0, not the Agent answer.
The outer Body is a JSON object containing that JSON text as its string value.
The nested snippet test_cases value is an array, not a further encoded string.

Allowed exact inner shapes:
- snippet: route, original_code, candidate_code, test_cases; keep frozen user
  source and independent COMPLETE stdout. Missing oracle never verifies repair.
- github: route, repo_url, job_id, request_started_at; only an existing capability
  is polled with wait_seconds=15. Existing prepare/verify plugins still start the
  asynchronous repository workflow; this plugin cannot replace those stages.
- advice: route only; fixed unexecuted result, no worker call or model report.

Output: is_error, result_json, receipt_url. Bind result_json directly into the
independent final-report code node, alongside the SAME frozen request_json.
HTTP 200 and is_error=false are not success verdicts; no model reasoning or free
text may enter the evidence channel. Use the original backend receipt value only.

This file and the OpenAPI contract contain no real credential, code or job ID.
Contract generation and local regression do not prove deployment, UI wiring,
new autonomous platform acceptance or publication. Validate all of those freshly.
`;
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
        description: "JSON-encoded array of 1 to 3 objects, each with path (existing non-test file path) and content (the complete replacement file, at most 12000 characters). Preserve indentation and encode newlines as JSON escapes. Do not modify tests or include extra fields. If the actual response has error=argument_must_be_a_json_array and executed=false, correct the encoding at most once; no job was dispatched and preparation was not consumed. Do not retry an accepted start request.",
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
  // This is a narrow HTTP workflow adapter, NOT a fifth MCP tool. The original
  // worker discovery contract and its four reviewed permissions stay unchanged.
  const executeContract = {
    openapi: "3.0.3", info: { title: "rescue_execute", version: "0.4.1", description: executeDescription },
    servers: [{ url: "https://reporescue-mcp-production.up.railway.app" }],
    paths: { "/xfyun/execute": { post: {
      operationId: "rescue_execute", summary: "Execute frozen snippet data, poll an existing job, or return fixed unexecuted advice.",
      description: executeDescription,
      security: [{ bearerAuth: [] }],
      requestBody: { required: true, content: { "application/json": { schema: {
        type: "object", required: ["request_json"], additionalProperties: false,
        properties: { request_json: { type: "string", minLength: 1, maxLength: 80000, description: executeRequestDescription } },
      } } } },
      responses: {
        "200": { description: "Original MCP result or fixed unexecuted advice. HTTP 200, is_error=false and a receipt URL never independently verify repair.", content: {
          "application/json": { schema: { type: "object", required: ["is_error", "result_json", "receipt_url"], properties: {
            is_error: { type: "boolean", description: "MCP error indicator only, not a repair verdict. Advice can be false while executed=false." },
            result_json: { type: "string", description: "Complete direct MCP result plus the gateway receipt_url mirror. Bind this string directly into the independent final-report node; parse content[0].text as business evidence. Never replace it with Agent output or REASONING_CONTENT." },
            receipt_url: { type: "string", description: "Exact gateway-minted original artifact receipt, only for a verified terminal repository repair. Empty for snippets, advice, pending, failed or unverified jobs. The report gate must validate the business result separately; do not invent or reconstruct links." },
          } } },
        } },
        ...Object.fromEntries(Object.entries({
          "400": "Malformed, duplicate-key, ambiguous or unsupported execution request; no worker execution.",
          "401": "Missing or invalid independent gateway Bearer authentication.",
          "403": "Browser Origin is not permitted; execution remains server-to-server.",
          "413": "Outer UTF-8 request body exceeds 1 MiB.",
          "415": "Content-Type must be application/json.",
          "429": "Shared request-rate or pending-worker capacity reached.",
          "503": "The fixed worker is not ready or available; no success evidence.",
          "504": "Worker response timed out; no success evidence.",
        }).map(([status, description]) => [status, { description }])),
      },
    } } },
    components: { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } } },
  };
  writeFileSync(join(output, "rescue_execute.json"), JSON.stringify(executeContract, null, 2) + "\n", "utf8");
  writeFileSync(join(output, "rescue_execute.instructions.txt"), executeInstructions, "utf8");
  process.stdout.write(JSON.stringify({ output, count: tools.length + 1, mcp_tool_count: tools.length, credentials_included: false }) + "\n");
} finally { child.kill(); }
