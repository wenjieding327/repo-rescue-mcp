# OpenClaw migration

RepoRescue keeps generation policy in a Skill and executable evidence in MCP, so the agent shell can change without rewriting the core.

## Hosted Node toolset

Use the repository's `stdio-server.mjs` when the host provides Node.js. It exposes quick snippet rescue plus compatibility/read-only repository surfaces:

```text
rescue_python_snippet
inspect_github_project
reproduce_python_project
windows_environment_probe
```

The Node launcher is the portable snippet-verification surface. Set `REPO_RESCUE_NODE_TOOLSET=snippet` on a public host so only `rescue_python_snippet` is discoverable. Its repository execution entry is deliberately disabled; use the Python MCP below for the complete repository Repair Agent loop.

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
openclaw mcp tools repo-rescue --include 'inspect_github_project,reproduce_python_project,repair_github_project,prepare_github_repair,start_prepare_github_repair,verify_github_patch,start_verify_github_patch,get_repair_job,run_interview_demo,get_repair_artifact,windows_environment_probe'
```

The Python server exposes two repository-repair paths. `repair_github_project` uses the optional `agent` dependency and a model API key. The host-agent path needs no separate key: short-call platforms should use `start_prepare_github_repair` → poll `get_repair_job` → generate the bounded proposal → `start_verify_github_patch` → poll the new job; long-call local hosts may use the synchronous `prepare_github_repair` → `verify_github_patch` pair. The async wire contract is `start.job.job_id` → `poll.job.result.preparation` → `poll.job.result.repair.verified_repair`; continue past preparation only when `repairable=true`. Never mix protocols in one repair. Both real repository paths require an allow-listed public repository and an isolated execution backend. `run_interview_demo` needs neither Docker nor external model credentials. `get_repair_artifact` returns patch/report/evidence content by run ID instead of exposing a server-local path.

Install or copy [`skills/verified-code-rescue`](skills/verified-code-rescue) into the host's Skill directory. The Skill contains routing, iteration, evidence grades, refusal rules, and user-facing output. It contains no hard-coded test results.

A snippet fix may be called verified only when the original fails and the candidate passes the same stated case. A repository run may be called P3 only when `reproduce_python_project` returns an actual command, scope, and exit code. Neither result implies official-demo or paper-metric reproduction.
