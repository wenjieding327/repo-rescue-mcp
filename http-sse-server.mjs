#!/usr/bin/env node

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";

const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_PORT = 3000;
const MAX_SESSIONS = 8;
const MAX_PENDING_REQUESTS = 4;
const MAX_SESSION_REQUESTS_PER_MINUTE = 120;
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_CHILD_MESSAGE_BYTES = 16 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 2 * 60_000;
const KEEPALIVE_MS = 15_000;
const STARTUP_TIMEOUT_MS = 10_000;
const PLATFORM_ENTRY = fileURLToPath(new URL("./platform-entry.mjs", import.meta.url));
const PREFLIGHT_INITIALIZE_ID = "repo-rescue-preflight-initialize";
const PREFLIGHT_TOOLS_ID = "repo-rescue-preflight-tools";
const REQUIRED_TOOL_NAMES = Object.freeze([
  "rescue_python_snippet",
  "start_prepare_github_repair",
  "get_repair_job",
  "start_verify_github_patch",
]);

function configuredPort(value) {
  const parsed = Number.parseInt(String(value ?? DEFAULT_PORT), 10);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) {
    throw new Error("PORT must be an integer between 0 and 65535.");
  }
  return parsed;
}

function configuredAccessToken(value) {
  const token = String(value || "").trim();
  if (Buffer.byteLength(token, "utf8") < 32 || Buffer.byteLength(token, "utf8") > 512) {
    throw new Error("REPO_RESCUE_HTTP_ACCESS_TOKEN must contain 32 to 512 UTF-8 bytes.");
  }
  return token;
}

function sameSecret(left, right) {
  const leftBytes = Buffer.from(String(left || ""), "utf8");
  const rightBytes = Buffer.from(String(right || ""), "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function bearerToken(request) {
  const authorization = String(request.headers.authorization || "");
  const match = /^Bearer[ \t]+([^\s]+)$/i.exec(authorization);
  return match?.[1] || "";
}

function sendJson(response, statusCode, value) {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  response.writeHead(statusCode, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

function sseEvent(response, event, data) {
  if (response.destroyed || response.writableEnded) return false;
  if (response.writableLength > MAX_CHILD_MESSAGE_BYTES) {
    response.destroy();
    return false;
  }
  const payload = typeof data === "string" ? data : JSON.stringify(data);
  return response.write(`event: ${event}\ndata: ${payload}\n\n`);
}

function childEnvironment(environment) {
  const child = {};
  for (const name of ["PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE"]) {
    if (environment[name] !== undefined) child[name] = environment[name];
  }
  if (environment.REPO_RESCUE_GITHUB_TOKEN !== undefined) {
    child.REPO_RESCUE_GITHUB_TOKEN = environment.REPO_RESCUE_GITHUB_TOKEN;
  }
  return child;
}

class PlatformProcess {
  constructor({ environment = process.env, onMessage, onFailure, onStarted }) {
    this.environment = environment;
    this.onMessage = onMessage;
    this.onFailure = onFailure;
    this.onStarted = onStarted;
    this.child = null;
    this.stdoutBuffer = Buffer.alloc(0);
    this.stopping = false;
  }

  start() {
    if (this.child) return;
    this.stopping = false;
    const child = spawn(process.execPath, [PLATFORM_ENTRY], {
      env: childEnvironment(this.environment),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    child.on("spawn", () => this.onStarted());
    child.stdout.on("data", (chunk) => this.#consume(chunk));
    child.stderr.on("data", () => {});
    child.on("error", () => {
      if (this.child === child) this.#failed("The MCP worker could not be started.");
    });
    child.on("close", () => {
      if (this.child === child) this.#failed("The MCP worker stopped unexpectedly.");
    });
    child.stdin.on("error", () => {});
  }

  send(message) {
    if (!this.child || this.child.killed || !this.child.stdin.writable) {
      throw new Error("The MCP worker is unavailable.");
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  stop() {
    this.stopping = true;
    const child = this.child;
    this.child = null;
    if (child && !child.killed) child.kill("SIGTERM");
  }

  #consume(chunk) {
    this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, chunk]);
    if (this.stdoutBuffer.length > MAX_CHILD_MESSAGE_BYTES && !this.stdoutBuffer.includes(0x0a)) {
      this.#failed("The MCP worker returned an oversized protocol message.");
      return;
    }
    while (true) {
      const newline = this.stdoutBuffer.indexOf(0x0a);
      if (newline < 0) break;
      const line = this.stdoutBuffer.subarray(0, newline).toString("utf8").trim();
      this.stdoutBuffer = this.stdoutBuffer.subarray(newline + 1);
      if (!line) continue;
      if (Buffer.byteLength(line, "utf8") > MAX_CHILD_MESSAGE_BYTES) {
        this.#failed("The MCP worker returned an oversized protocol message.");
        return;
      }
      try {
        this.onMessage(JSON.parse(line));
      } catch {
        this.#failed("The MCP worker returned malformed JSON-RPC.");
        return;
      }
    }
  }

  #failed(message) {
    const wasStopping = this.stopping;
    const child = this.child;
    if (!child) return;
    this.child = null;
    this.stdoutBuffer = Buffer.alloc(0);
    if (child && !child.killed) child.kill("SIGKILL");
    if (!wasStopping) this.onFailure(message);
  }
}

export function createLegacySseServer({
  environment = process.env,
  host = environment.HOST || DEFAULT_HOST,
  port = configuredPort(environment.PORT),
  accessToken = configuredAccessToken(environment.REPO_RESCUE_HTTP_ACCESS_TOKEN),
} = {}) {
  const sessions = new Map();
  const pending = new Map();
  let globalRequests = [];
  let sequence = 0;
  let closed = false;
  let ready = false;
  let initialReadyResolve;
  let initialReadyReject;
  const initialReady = new Promise((resolve, reject) => {
    initialReadyResolve = resolve;
    initialReadyReject = reject;
  });

  function deliver(item, message, httpStatus = 200) {
    if (item.httpResponse) {
      if (!item.httpResponse.destroyed && !item.httpResponse.writableEnded) {
        // Keep the entire original MCP result as evidence. Do not reinterpret
        // HTTP success as a verified repair or manufacture tool status fields.
        sendJson(item.httpResponse, httpStatus, {
          is_error: Boolean(message.error || message.result?.isError),
          result_json: JSON.stringify(message.error ? { error: message.error } : message.result),
        });
      }
      return;
    }
    const session = sessions.get(item.sessionId);
    if (session) sseEvent(session.response, "message", { ...message, id: item.originalId });
  }

  function closeSessions() {
    for (const [sessionId, session] of sessions) {
      session.response.end();
      removeSession(sessionId);
    }
  }

  function failPending(message) {
    for (const [internalId, item] of pending) {
      clearTimeout(item.timer);
      deliver(item, {
          jsonrpc: "2.0",
          id: item.originalId,
          error: { code: -32603, message },
      }, 503);
      pending.delete(internalId);
    }
  }

  const platform = new PlatformProcess({
    environment,
    onStarted() {
      ready = false;
      platform.send({
        jsonrpc: "2.0",
        id: PREFLIGHT_INITIALIZE_ID,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "repo-rescue-http-gateway", version: "1" },
        },
      });
    },
    onMessage(message) {
      const internalId = message?.id;
      if (internalId === undefined || internalId === null) return;
      if (internalId === PREFLIGHT_INITIALIZE_ID) {
        if (message.error || message.result?.serverInfo?.name !== "repo-rescue-mcp") {
          initialReadyReject(new Error("The MCP worker failed its initialize preflight."));
          platform.stop();
          return;
        }
        platform.send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
        platform.send({ jsonrpc: "2.0", id: PREFLIGHT_TOOLS_ID, method: "tools/list", params: {} });
        return;
      }
      if (internalId === PREFLIGHT_TOOLS_ID) {
        const names = Array.isArray(message.result?.tools) ? message.result.tools.map((tool) => tool?.name) : [];
        const exact = names.length === REQUIRED_TOOL_NAMES.length
          && REQUIRED_TOOL_NAMES.every((name, index) => names[index] === name);
        if (!exact) {
          initialReadyReject(new Error("The MCP worker did not expose the reviewed four-tool surface."));
          platform.stop();
          return;
        }
        ready = true;
        initialReadyResolve();
        return;
      }
      const item = pending.get(String(internalId));
      if (!item) return;
      pending.delete(String(internalId));
      clearTimeout(item.timer);
      deliver(item, message);
    },
    onFailure(message) {
      ready = false;
      failPending(message);
      closeSessions();
      if (!closed) setTimeout(() => { if (!closed) platform.start(); }, 250).unref();
    },
  });

  function authenticated(request) {
    return sameSecret(bearerToken(request), accessToken);
  }

  function removeSession(sessionId) {
    const session = sessions.get(sessionId);
    if (!session) return;
    clearInterval(session.keepalive);
    sessions.delete(sessionId);
    // Keep outstanding work reserved until completion/timeout. Disconnecting
    // must not free capacity while the shared worker is still executing it.
  }

  function openSse(request, response) {
    if (!authenticated(request)) {
      sendJson(response, 401, { ok: false, error: "unauthorized" });
      return;
    }
    if (!ready) {
      sendJson(response, 503, { ok: false, error: "mcp_worker_unavailable" });
      return;
    }
    if (sessions.size >= MAX_SESSIONS) {
      sendJson(response, 503, { ok: false, error: "session_capacity_reached" });
      return;
    }
    const sessionId = randomBytes(32).toString("base64url");
    response.writeHead(200, {
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream; charset=utf-8",
      "X-Accel-Buffering": "no",
      "X-Content-Type-Options": "nosniff",
    });
    response.flushHeaders?.();
    const keepalive = setInterval(() => response.write(": keepalive\n\n"), KEEPALIVE_MS);
    keepalive.unref();
    sessions.set(sessionId, { response, keepalive, requests: [] });
    response.on("close", () => removeSession(sessionId));
    sseEvent(response, "endpoint", `/messages/?session_id=${encodeURIComponent(sessionId)}`);
  }

  function receiveMessage(request, response, url, toolName = null) {
    if (!authenticated(request)) {
      sendJson(response, 401, { ok: false, error: "unauthorized" });
      return;
    }
    const sessionId = String(url.searchParams.get("session_id") || "");
    const session = toolName ? { requests: [] } : sessions.get(sessionId);
    if (!session) {
      sendJson(response, 404, { ok: false, error: "unknown_session" });
      return;
    }
    const now = Date.now();
    globalRequests = globalRequests.filter((startedAt) => now - startedAt < 60_000);
    session.requests = session.requests.filter((startedAt) => now - startedAt < 60_000);
    if (globalRequests.length >= MAX_SESSION_REQUESTS_PER_MINUTE
      || session.requests.length >= MAX_SESSION_REQUESTS_PER_MINUTE || pending.size >= MAX_PENDING_REQUESTS) {
      sendJson(response, 429, { ok: false, error: "request_rate_limited" });
      return;
    }
    session.requests.push(now);
    globalRequests.push(now);
    const contentType = String(request.headers["content-type"] || "").split(";", 1)[0].trim().toLowerCase();
    if (contentType !== "application/json") {
      sendJson(response, 415, { ok: false, error: "content_type_must_be_application_json" });
      return;
    }
    const chunks = [];
    let received = 0;
    let finished = false;
    request.on("data", (chunk) => {
      if (finished) return;
      received += chunk.length;
      if (received > MAX_REQUEST_BYTES) {
        finished = true;
        chunks.length = 0;
        sendJson(response, 413, { ok: false, error: "request_body_too_large" });
      } else {
        chunks.push(chunk);
      }
    });
    request.on("end", () => {
      if (finished) return;
      let message;
      try {
        message = JSON.parse(Buffer.concat(chunks, received).toString("utf8"));
      } catch {
        sendJson(response, 400, { ok: false, error: "invalid_json" });
        return;
      }
      if (toolName) {
        if (!message || typeof message !== "object" || Array.isArray(message)) {
          sendJson(response, 400, { ok: false, error: "arguments_must_be_an_object" });
          return;
        }
        message = { jsonrpc: "2.0", id: "http-tool", method: "tools/call",
          params: { name: toolName, arguments: message } };
      }
      if (!message || typeof message !== "object" || Array.isArray(message) || message.jsonrpc !== "2.0"
        || typeof message.method !== "string"
        || (message.id !== undefined && message.id !== null && typeof message.id !== "string" && typeof message.id !== "number")) {
        sendJson(response, 400, { ok: false, error: "invalid_jsonrpc" });
        return;
      }
      const hasId = message.id !== undefined && message.id !== null;
      // Admission must be checked after receiving the body too: concurrent uploads
      // can all pass the initial check before any request has reserved capacity.
      if ((!toolName && !sessions.has(sessionId)) || !ready) {
        sendJson(response, 503, { ok: false, error: "session_or_worker_unavailable" });
        return;
      }
      if (hasId && pending.size >= MAX_PENDING_REQUESTS) {
        sendJson(response, 429, { ok: false, error: "request_rate_limited" });
        return;
      }
      const internalId = hasId ? `http-${++sequence}-${randomBytes(12).toString("base64url")}` : null;
      if (hasId) {
        const timer = setTimeout(() => {
          const item = pending.get(internalId);
          if (!item) return;
          pending.delete(internalId);
          deliver(item, {
              jsonrpc: "2.0",
              id: item.originalId,
              error: { code: -32603, message: "The MCP worker response timed out." },
          }, 504);
        }, REQUEST_TIMEOUT_MS);
        timer.unref();
        pending.set(internalId, {
          sessionId, originalId: message.id, timer,
          httpResponse: toolName ? response : null,
        });
      }
      try {
        platform.send(hasId ? { ...message, id: internalId } : message);
      } catch {
        if (hasId) {
          const item = pending.get(internalId);
          if (item) clearTimeout(item.timer);
          pending.delete(internalId);
        }
        sendJson(response, 503, { ok: false, error: "mcp_worker_unavailable" });
        return;
      }
      // HTTP plugins receive the tool result directly. SSE clients still get
      // a 202 acknowledgement and their response over the existing stream.
      if (toolName) return;
      response.writeHead(202, {
        "Cache-Control": "no-store",
        "Content-Length": "0",
        "X-Content-Type-Options": "nosniff",
      });
      response.end();
    });
    request.on("error", () => {
      if (!response.headersSent) sendJson(response, 400, { ok: false, error: "request_body_rejected" });
    });
  }

  const server = createServer((request, response) => {
    // This private endpoint serves server-to-server MCP clients, not web pages.
    if (request.headers.origin !== undefined) {
      sendJson(response, 403, { ok: false, error: "browser_origin_not_allowed" });
      return;
    }
    let url;
    try {
      url = new URL(request.url || "/", "http://localhost");
    } catch {
      sendJson(response, 400, { ok: false, error: "invalid_url" });
      return;
    }
    if (request.method === "GET" && url.pathname === "/healthz") {
      sendJson(response, ready ? 200 : 503, { ok: ready, service: "repo-rescue-mcp", transport: "legacy-sse" });
      return;
    }
    if (request.method === "GET" && url.pathname === "/sse") {
      openSse(request, response);
      return;
    }
    if (request.method === "POST" && (url.pathname === "/messages" || url.pathname === "/messages/")) {
      receiveMessage(request, response, url);
      return;
    }
    if (request.method === "POST" && url.pathname.startsWith("/api/tools/")) {
      const toolName = url.pathname.slice("/api/tools/".length);
      if (!authenticated(request)) {
        sendJson(response, 401, { ok: false, error: "unauthorized" });
      } else if (!REQUIRED_TOOL_NAMES.includes(toolName)) {
        sendJson(response, 404, { ok: false, error: "tool_unavailable" });
      } else {
        receiveMessage(request, response, url, toolName);
      }
      return;
    }
    sendJson(response, 404, { ok: false, error: "not_found" });
  });

  server.on("clientError", (_error, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });

  return {
    server,
    async listen() {
      if (closed) throw new Error("The server has already been closed.");
      platform.start();
      let startupTimer;
      try {
        await Promise.race([
          initialReady,
          new Promise((_, reject) => {
            startupTimer = setTimeout(() => reject(new Error("The MCP worker preflight timed out.")), STARTUP_TIMEOUT_MS);
          }),
        ]);
      } catch (error) {
        closed = true;
        platform.stop();
        throw error;
      } finally {
        clearTimeout(startupTimer);
      }
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          resolve();
        });
      });
      return server.address();
    },
    async close() {
      if (closed) return;
      closed = true;
      closeSessions();
      failPending("The MCP service is shutting down.");
      platform.stop();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

async function main() {
  const service = createLegacySseServer();
  const address = await service.listen();
  const displayHost = typeof address === "object" && address ? address.address : DEFAULT_HOST;
  const displayPort = typeof address === "object" && address ? address.port : configuredPort(process.env.PORT);
  process.stderr.write(`RepoRescue MCP SSE listening on ${displayHost}:${displayPort}\n`);
  const shutdown = async () => {
    await service.close();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    process.stderr.write(`RepoRescue MCP startup failed: ${String(error?.message || error)}\n`);
    process.exitCode = 1;
  });
}
