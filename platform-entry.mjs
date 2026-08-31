#!/usr/bin/env node

// Hosted competition entrypoint. Keep the reviewed, non-secret execution
// boundary in code so the platform only needs to inject the short-lived
// GitHub token when the private MCP is linked to the team's APPID.
const PLATFORM_CONFIGURATION = Object.freeze({
  REPO_RESCUE_NODE_TOOLSET: "platform",
  REPO_RESCUE_ACTIONS_REPOSITORY: "wenjieding327/repo-rescue-mcp",
  REPO_RESCUE_ACTIONS_WORKFLOW: "repo-rescue-actions-bridge.yml",
  REPO_RESCUE_ACTIONS_REF: "main",
  REPO_RESCUE_ALLOWED_REPOS: "wenjieding327/repo-rescue-canary,wenjieding327/repo-rescue-mcp",
  REPO_RESCUE_ACTIONS_MAX_ACTIVE: "1",
  REPO_RESCUE_ACTIONS_STARTS_PER_MINUTE: "3",
  REPO_RESCUE_ACTIONS_STARTS_PER_HOUR: "12",
  REPO_RESCUE_ACTIONS_MIN_POLL_MS: "2000",
  REPO_RESCUE_ACTIONS_RESULT_TTL_MS: "900000",
  REPO_RESCUE_ACTIONS_DISPATCH_DISCOVERY_MS: "120000",
  REPO_RESCUE_ACTIONS_MAX_RUN_MS: "1320000",
  REPO_RESCUE_ACTIONS_REQUEST_TIMEOUT_MS: "15000",
  REPO_RESCUE_ACTIONS_ARTIFACT_TIMEOUT_MS: "30000",
  REPO_RESCUE_SNIPPET_WORKER_TIMEOUT_MS: "6000",
});

for (const [name, value] of Object.entries(PLATFORM_CONFIGURATION)) {
  process.env[name] = value;
}

await import("./stdio-server.mjs");
