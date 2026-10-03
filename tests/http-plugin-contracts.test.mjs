import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { before, test } from "node:test";
import { parseXfyunExecutionRequest } from "../http-sse-server.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const ORIGIN = "https://reporescue-mcp-production.up.railway.app";
const TITLES = ["rescue_snippet", "rescue_prepare", "rescue_poll", "rescue_verify", "rescue_execute"];
let contracts, instructions, metadata;

before(() => {
  const environment = { npm_config_update_notifier: "false" };
  for (const name of ["PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE"]) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  // Artificial values prove the builder does not inherit caller credentials or
  // host overrides. They are not credentials and never access a provider.
  Object.assign(environment, {
    REPO_RESCUE_HTTP_ACCESS_TOKEN: "MOCK-GATEWAY-CONTRACT-SENTINEL-NOT-A-REAL-CREDENTIAL",
    REPO_RESCUE_GITHUB_TOKEN: "MOCK-PAT-CONTRACT-SENTINEL-NOT-A-REAL-CREDENTIAL",
    REPO_RESCUE_PUBLIC_ORIGIN: "https://mock-origin-must-not-be-exported.example",
    HOST: "mock-host-must-not-be-exported.example",
  });
  metadata = JSON.parse(execFileSync(process.execPath, [fileURLToPath(new URL("../scripts/build-http-plugin-contracts.mjs", import.meta.url))], {
    cwd: ROOT, env: environment, timeout: 15000, windowsHide: true, encoding: "utf8",
  }));
  contracts = Object.fromEntries(TITLES.map((title) => [title, JSON.parse(readFileSync(new URL(`../dist/http-plugins/${title}.json`, import.meta.url), "utf8"))]));
  instructions = readFileSync(new URL("../dist/http-plugins/rescue_execute.instructions.txt", import.meta.url), "utf8");
});

test("builder emits five HTTP contracts while preserving four MCP tools and no credential/host overrides", () => {
  assert.equal(metadata.count, 5);
  assert.equal(metadata.mcp_tool_count, 4);
  assert.equal(metadata.credentials_included, false);
  const text = JSON.stringify(contracts) + instructions + JSON.stringify(metadata);
  for (const sentinel of ["MOCK-GATEWAY-CONTRACT-SENTINEL", "MOCK-PAT-CONTRACT-SENTINEL", "mock-origin-must-not-be-exported", "mock-host-must-not-be-exported"]) {
    assert.equal(text.includes(sentinel), false);
  }
  for (const title of TITLES) {
    const contract = contracts[title];
    assert.equal(contract.openapi, "3.0.3");
    assert.deepEqual(contract.servers, [{ url: ORIGIN }]);
    assert.deepEqual(contract.components.securitySchemes.bearerAuth, { type: "http", scheme: "bearer" });
    assert.equal(Object.keys(contract.paths).length, 1);
    const post = Object.values(contract.paths)[0].post;
    assert.equal(post.operationId, title);
    assert.deepEqual(post.security, [{ bearerAuth: [] }]);
    assert.equal(post.requestBody.required, true);
    assert.deepEqual(post.responses["200"].content["application/json"].schema.required, ["is_error", "result_json", "receipt_url"]);
  }
});

test("rescue_execute has one strict String Body input, no default/example or caller-selected tools", () => {
  const contract = contracts.rescue_execute;
  assert.deepEqual(Object.keys(contract.paths), ["/xfyun/execute"]);
  assert.deepEqual(Object.keys(contract.paths["/xfyun/execute"]), ["post"]);
  const post = contract.paths["/xfyun/execute"].post;
  assert.equal(post.parameters, undefined);
  const schema = post.requestBody.content["application/json"].schema;
  assert.equal(schema.type, "object");
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ["request_json"]);
  assert.deepEqual(Object.keys(schema.properties), ["request_json"]);
  const field = schema.properties.request_json;
  assert.equal(field.type, "string");
  assert.equal(field.minLength, 1);
  assert.equal(field.maxLength, 80000);
  for (const key of ["default", "example", "examples", "items", "properties"]) assert.equal(Object.hasOwn(field, key), false);
  const visit = (value) => {
    if (value !== null && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        assert.equal(["default", "example", "examples"].includes(key), false);
        visit(child);
      }
    }
  };
  visit(contract);
  assert.match(field.description, /directly.*key0/);
  assert.match(field.description, /native JSON array/);
  assert.match(field.description, /complete program stdout/);
  assert.match(field.description, /only polls, cannot start work/);
  assert.match(post.description, /Service > Header, Authorization/);
});

test("old direct-tool schemas retain HTTP-only JSON array strings and reserved receipt mirrors", () => {
  for (const [title, tool, field] of [["rescue_snippet", "rescue_python_snippet", "test_cases"], ["rescue_verify", "start_verify_github_patch", "changes"]]) {
    const post = contracts[title].paths[`/api/tools/${tool}`].post;
    const schema = post.requestBody.content["application/json"].schema.properties[field];
    assert.equal(schema.type, "string");
    assert.equal(Object.hasOwn(schema, "default"), false);
    assert.equal(Object.hasOwn(schema, "items"), false);
    assert.match(schema.description, /JSON-encoded array/);
    assert.match(post.responses["200"].content["application/json"].schema.properties.result_json.description, /receipt_url mirror/);
  }
  assert.ok(contracts.rescue_prepare.paths["/api/tools/start_prepare_github_repair"]);
  assert.ok(contracts.rescue_poll.paths["/api/tools/get_repair_job"]);
});

test("documented inner requests agree with strict server parser and never grant dispatch permissions", () => {
  const encode = (request) => JSON.stringify({ request_json: JSON.stringify(request) });
  const request = { route: "snippet", original_code: "print(0)", candidate_code: "print(1)", test_cases: [{ name: "complete_program", stdin: "", expected_stdout: "1" }] };
  assert.deepEqual(parseXfyunExecutionRequest(encode(request)).arguments.test_cases, request.test_cases);
  assert.equal(parseXfyunExecutionRequest(encode({ ...request, test_cases: [{ name: "complete_program", stdin: "" }] })).toolName, "rescue_python_snippet");
  assert.deepEqual(parseXfyunExecutionRequest(encode({ route: "github", repo_url: "https://github.com/team/repo", job_id: "J".repeat(43), request_started_at: "2026-10-03T08:00:00.000Z" })), {
    route: "github", toolName: "get_repair_job", arguments: { job_id: "J".repeat(43), wait_seconds: 15 },
  });
  assert.deepEqual(parseXfyunExecutionRequest(encode({ route: "advice" })), { route: "advice", toolName: null, arguments: null });
  for (const rejected of [{ ...request, test_cases: "[]" }, { route: "prepare", repo_url: "https://github.com/team/repo" }, { route: "verify", changes: [] }, { route: "advice", toolName: "start_verify_github_patch" }]) {
    assert.throws(() => parseXfyunExecutionRequest(encode(rejected)));
  }
  assert.throws(() => parseXfyunExecutionRequest(JSON.stringify({ request_json: request })));
});

test("contract responses and separate setup guide preserve fail-closed evidence and publication boundaries", () => {
  const post = contracts.rescue_execute.paths["/xfyun/execute"].post;
  for (const code of ["200", "400", "401", "403", "413", "415", "429", "503", "504"]) assert.ok(post.responses[code]?.description);
  assert.match(post.responses["200"].description, /never independently verify repair/);
  const outputs = post.responses["200"].content["application/json"].schema.properties;
  assert.equal(outputs.is_error.type, "boolean");
  assert.equal(outputs.result_json.type, "string");
  assert.equal(outputs.receipt_url.type, "string");
  assert.match(outputs.result_json.description, /independent final-report node/);
  assert.match(outputs.receipt_url.description, /Empty for snippets, advice, pending, failed or unverified/);
  for (const phrase of ["type String", "location to Body", "candidate-binding key0", "SAME frozen request_json", "COMPLETE", "not deployed or accepted", "cannot replace those stages", "new autonomous platform acceptance"]) {
    assert.ok(instructions.includes(phrase), phrase);
  }
});
