# OpenClaw migration

RepoRescue keeps generation policy in a Skill and executable evidence in MCP, so the agent shell can change without rewriting the core.

## Hosted Node toolset

Use the repository's `stdio-server.mjs` when the host provides Node.js. It exposes quick snippet rescue plus repository evidence tools:

```text
rescue_python_snippet
inspect_github_project
reproduce_python_project
windows_environment_probe
```

## Python repository toolset

For local container-backed repository reproduction:

```bash
openclaw mcp add repo-rescue \
  --command uvx \
  --arg --from \
  --arg git+https://github.com/wenjieding327/repo-rescue-mcp@COMMIT_SHA \
  --arg repo-rescue-mcp \
  --env REPO_RESCUE_ALLOWED_REPOS=pallets/click

openclaw mcp doctor repo-rescue --probe
openclaw mcp tools repo-rescue --include 'inspect_github_project,reproduce_python_project,windows_environment_probe'
```

Install or copy [`skills/verified-code-rescue`](skills/verified-code-rescue) into the host's Skill directory. The Skill contains routing, iteration, evidence grades, refusal rules, and user-facing output. It contains no hard-coded test results.

A snippet fix may be called verified only when the original fails and the candidate passes the same stated case. A repository run may be called P3 only when `reproduce_python_project` returns an actual command, scope, and exit code. Neither result implies official-demo or paper-metric reproduction.
