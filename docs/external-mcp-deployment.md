# External MCP deployment

The Node HTTP gateway runs one long-lived `platform-entry.mjs` process. It
preserves the reviewed four tools, shared Actions quotas, and job capabilities
across SSE reconnects. It requires **one replica**. Restarts lose in-memory
job capabilities; existing jobs must not be reported as verified after a restart.

Use a dedicated Node build context, not the repository-root Python Dockerfile:

```powershell
$stage = node scripts/build-railway-package.mjs
railway up $stage --path-as-root --project <project> --environment production --service <service> --detach --json
```

Set `REPO_RESCUE_HTTP_ACCESS_TOKEN` to an independently generated secret of at
least 32 bytes. Clients send `Authorization: Bearer ...` on both GET `/sse` and
POST `/messages/`. Never reuse a GitHub credential for gateway authentication.
The gateway rejects browser Origin headers and unauthenticated MCP calls.
`PORT` defaults to 3000; Railway supplies its listening port. `/healthz` succeeds
only after the worker initializes and exposes exactly the expected four tools.

Repository tools additionally need a fine-grained `REPO_RESCUE_GITHUB_TOKEN`
limited to Actions read/write and Metadata read-only on
`wenjieding327/repo-rescue-mcp`. Inject through the hosting provider's secret
settings. Never commit, log, screenshot, or place these secrets in URLs.
Without it, snippet verification works and repository operations fail closed.

Remote verification uses the official MCP Python client:

```powershell
railway run --project <project> --environment production --service <service> -- .venv/Scripts/python.exe scripts/smoke_platform_sse.py https://<host>/sse
```

The smoke checks discovery, a real before/after repair, unsafe import rejection,
hidden-tool rejection, and a ping after a full SSE keepalive interval. It does
not constitute Agent workflow or repository repair acceptance.

## Verified checkpoint: 2026-09-09

- Local Node tests: 51/51 passed before the additional shared-capacity hardening.
- Railway deployment `b269dcb4-a262-44b6-b2ac-e65037ab7d10` started the Node gateway.
- Public health: HTTP 200; unauthenticated SSE: HTTP 401.
- Official-client remote discovery: exactly four tools.
- Real snippet: `ZeroDivisionError` before, output `0` after, `fix_verified=true`.
- `import os`: `PermissionError`, `fix_verified=false`.
- Hidden tool rejected; sustained SSE ping passed.
- Hosted XFYun endpoint `7500319772569477120` still returned HTTP 200 with no
  endpoint event on 2026-09-09. Its recovery remains unverified.

Outstanding: deploy the latest hardening, confirm the Agent editor supports the
required authentication headers, inject the least-privilege repository credential,
run the real Agent canary prepare/poll/verify/poll, then publish the existing Bot.
Neither the Bot nor the competition submission is marked complete by these checks.
Railway Free has limited credit and can sleep; it is not an always-on service guarantee.
