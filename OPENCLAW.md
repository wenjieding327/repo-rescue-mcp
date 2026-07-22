# OpenClaw migration

RepoRescue keeps its executable evidence layer in MCP so the agent shell can be replaced without rewriting the core.

```bash
openclaw mcp add repo-rescue \
  --command uvx \
  --arg --from \
  --arg git+https://github.com/wenjieding327/repo-rescue-mcp@COMMIT_SHA \
  --arg repo-rescue-mcp \
  --env REPO_RESCUE_ALLOWED_REPOS=pallets/click \
  --env REPO_RESCUE_EXECUTION_BACKEND=direct

openclaw mcp doctor repo-rescue --probe
openclaw mcp tools repo-rescue --include 'inspect_github_project,reproduce_python_project,windows_environment_probe'
```

The OpenClaw Skill should contain orchestration rules, refusal conditions, output format, and demo tasks. It must not contain hard-coded test results. A run may be called verified only when `reproduce_python_project` returns `verified=true` and an actual exit code.

The dependency-free `stdio-server.mjs` launcher is for hosted MCP products that have `node`/`npx` but no `uvx`. The Python server remains the canonical local and OpenClaw implementation.
