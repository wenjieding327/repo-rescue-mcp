import assert from "node:assert/strict";
import test from "node:test";
import { request as httpRequest } from "node:http";
import { createLegacySseServer } from "../http-sse-server.mjs";

const ACCESS_TOKEN = "test-only-access-token-with-at-least-32-bytes";

async function startServer(t, environment = {}) {
  const service = createLegacySseServer({
    environment: {
      ...process.env,
      REPO_RESCUE_GITHUB_TOKEN: "",
      ...environment,
    },
    host: "127.0.0.1",
    port: 0,
    accessToken: ACCESS_TOKEN,
  });
  const address = await service.listen();
  t.after(() => service.close());
  return { service, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function openSession(baseUrl, token = ACCESS_TOKEN) {
  const controller = new AbortController();
  const response = await fetch(`${baseUrl}/sse`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: controller.signal,
  });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  async function nextEvent() {
    while (!buffered.includes("\n\n")) {
      const { done, value } = await reader.read();
      if (done) throw new Error("SSE stream ended before the next event.");
      buffered += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
    }
    const boundary = buffered.indexOf("\n\n");
    const raw = buffered.slice(0, boundary);
    buffered = buffered.slice(boundary + 2);
    const fields = Object.fromEntries(raw.split("\n").filter((line) => !line.startsWith(":" )).map((line) => {
      const separator = line.indexOf(":");
      return [line.slice(0, separator), line.slice(separator + 1).trimStart()];
    }));
    return {
      event: fields.event,
      data: fields.data === undefined
        ? undefined
        : fields.event === "endpoint"
          ? fields.data
          : JSON.parse(fields.data),
    };
  }
  return { response, controller, nextEvent };
}

async function postRpc(baseUrl, endpoint, message, token = ACCESS_TOKEN) {
  return fetch(new URL(endpoint, baseUrl), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(message),
  });
}

test("health is public but the MCP transport requires a bearer token", async (t) => {
  const { baseUrl } = await startServer(t);
  const health = await fetch(`${baseUrl}/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true, service: "repo-rescue-mcp", transport: "legacy-sse" });
  const unauthorized = await fetch(`${baseUrl}/sse`);
  assert.equal(unauthorized.status, 401);
  assert.equal((await unauthorized.json()).error, "unauthorized");
});

test("legacy SSE announces its POST endpoint and preserves caller JSON-RPC ids", async (t) => {
  const { baseUrl } = await startServer(t);
  const session = await openSession(baseUrl);
  t.after(() => session.controller.abort());
  assert.equal(session.response.status, 200);
  assert.match(session.response.headers.get("content-type"), /^text\/event-stream/);
  const endpoint = await session.nextEvent();
  assert.equal(endpoint.event, "endpoint");
  assert.match(endpoint.data, /^\/messages\/\?session_id=[A-Za-z0-9_-]{43}$/);

  const accepted = await postRpc(baseUrl, endpoint.data, {
    jsonrpc: "2.0",
    id: "caller-visible-id",
    method: "initialize",
    params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } },
  });
  assert.equal(accepted.status, 202);
  const reply = await session.nextEvent();
  assert.equal(reply.event, "message");
  assert.equal(reply.data.id, "caller-visible-id");
  assert.equal(reply.data.result.serverInfo.name, "repo-rescue-mcp");
});

test("the HTTP transport exposes exactly the reviewed four-tool platform surface", async (t) => {
  const { baseUrl } = await startServer(t);
  const session = await openSession(baseUrl);
  t.after(() => session.controller.abort());
  const endpoint = (await session.nextEvent()).data;
  const accepted = await postRpc(baseUrl, endpoint, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  assert.equal(accepted.status, 202);
  const reply = await session.nextEvent();
  assert.deepEqual(
    reply.data.result.tools.map((tool) => tool.name),
    ["rescue_python_snippet", "start_prepare_github_repair", "get_repair_job", "start_verify_github_patch"],
  );
});

test("message POSTs reject wrong credentials, content types, and unknown sessions", async (t) => {
  const { baseUrl } = await startServer(t);
  const session = await openSession(baseUrl);
  t.after(() => session.controller.abort());
  const endpoint = (await session.nextEvent()).data;
  const wrongToken = await postRpc(baseUrl, endpoint, { jsonrpc: "2.0", id: 1, method: "ping" }, "wrong-token");
  assert.equal(wrongToken.status, 401);
  const wrongType = await fetch(new URL(endpoint, baseUrl), {
    method: "POST",
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, "Content-Type": "text/plain" },
    body: "{}",
  });
  assert.equal(wrongType.status, 415);
  const unknown = await postRpc(baseUrl, "/messages/?session_id=missing", { jsonrpc: "2.0", id: 1, method: "ping" });
  assert.equal(unknown.status, 404);
});

test("repository tools fail closed when the GitHub credential is absent", async (t) => {
  const { baseUrl } = await startServer(t);
  const session = await openSession(baseUrl);
  t.after(() => session.controller.abort());
  const endpoint = (await session.nextEvent()).data;
  await postRpc(baseUrl, endpoint, {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "start_prepare_github_repair", arguments: { repo_url: "https://github.com/wenjieding327/repo-rescue-canary" } },
  });
  const reply = await session.nextEvent();
  assert.equal(reply.data.id, 3);
  assert.equal(reply.data.result.isError, false);
  const value = JSON.parse(reply.data.result.content[0].text);
  assert.equal(value.ok, false);
  assert.equal(value.status, "configuration_required");
});

test("chunked oversized uploads receive one rejection and leave the worker usable", { timeout: 15000 }, async (t) => {
  const { baseUrl } = await startServer(t);
  const session = await openSession(baseUrl);
  t.after(() => session.controller.abort());
  const endpoint = (await session.nextEvent()).data;
  const status = await new Promise((resolve, reject) => {
    const upload = httpRequest(new URL(endpoint, baseUrl), {
      method: "POST",
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, "Content-Type": "application/json" },
    }, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode));
    });
    upload.on("error", reject);
    // Multiple data chunks after the first rejected chunk reproduced a process crash.
    for (let i = 0; i < 32; i++) upload.write(Buffer.alloc(65536, 120));
    upload.end();
  });
  assert.equal(status, 413);
  assert.equal((await fetch(`${baseUrl}/healthz`)).status, 200);
  assert.equal((await postRpc(baseUrl, endpoint, { jsonrpc: "2.0", id: 5, method: "ping" })).status, 202);
  assert.deepEqual((await session.nextEvent()).data, { jsonrpc: "2.0", id: 5, result: {} });
});

test("sessions with identical request ids receive only their own replies", { timeout: 15000 }, async (t) => {
  const { baseUrl } = await startServer(t);
  const first = await openSession(baseUrl);
  const second = await openSession(baseUrl);
  t.after(() => { first.controller.abort(); second.controller.abort(); });
  const firstEndpoint = (await first.nextEvent()).data;
  const secondEndpoint = (await second.nextEvent()).data;
  await Promise.all([
    postRpc(baseUrl, firstEndpoint, { jsonrpc: "2.0", id: 1, method: "ping" }),
    postRpc(baseUrl, secondEndpoint, { jsonrpc: "2.0", id: 1, method: "tools/list" }),
  ]);
  assert.deepEqual((await first.nextEvent()).data.result, {});
  assert.equal((await second.nextEvent()).data.result.tools.length, 4);
});

test("invalid JSON-RPC and direct hidden tools cannot bypass the gateway", { timeout: 15000 }, async (t) => {
  const { baseUrl } = await startServer(t);
  const session = await openSession(baseUrl);
  t.after(() => session.controller.abort());
  const endpoint = (await session.nextEvent()).data;
  for (const message of [[], null, { jsonrpc: "2.0", id: {} }, { jsonrpc: "2.0", method: 1 }]) {
    assert.equal((await postRpc(baseUrl, endpoint, message)).status, 400);
  }
  await postRpc(baseUrl, endpoint, {
    jsonrpc: "2.0", id: 6, method: "tools/call",
    params: { name: "windows_environment_probe", arguments: {} },
  });
  const reply = (await session.nextEvent()).data;
  assert.equal(reply.result.isError, true);
  assert.equal(JSON.parse(reply.result.content[0].text).status, "tool_unavailable");
});
