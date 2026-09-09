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

The hardened SSE deployment `5b7e52f0-6d73-4466-82ec-3905ca1d8aef` also passed
the official-client remote smoke. It was merged to main as
`e39a3c7aea7f8c392146fd0d9b7b921d75133dd7`; reliability CI `34346247148`
passed Docker, Ubuntu and Windows.

Outstanding: inject the least-privilege repository credential, complete the
authenticated Agent integration and real canary prepare/poll/verify/poll, then
publish the existing Bot.
Neither the Bot nor the competition submission is marked complete by these checks.
Railway Free has limited credit and can sleep; it is not an always-on service guarantee.

## XFYun HTTP plugin adapter

On 2026-09-09 the actual Agent editor exposed only an address field for custom
MCP; no header field was visible. The custom **plugin** creation form explicitly
supports **Service > Header**, parameter name and Service token. The adapter
therefore offers four `POST /api/tools/<original-tool-name>` routes. These share
the SSE worker, credentials, global admission limits and execution safeguards.
Only the reviewed four names are accepted. No anonymous execution is enabled.

The JSON request body is the original tool's arguments object. The response has
`is_error` and `result_json`; parse the latter as the complete original MCP result,
then parse `content[0].text` as the original evidence. Neither HTTP 200 nor
`is_error=false` implies a successful repair: only the original verification
fields can justify that claim.

Generate four credential-free OpenAPI contracts with
`node scripts/build-http-plugin-contracts.mjs`. Configure the plugin's Service
authentication with Header name `Authorization` and value `Bearer <gateway
access token>`; do not put this token in URLs, descriptions or model prompts.
Changing recipients or granting repository credentials requires user approval.

Adapter local full Node suite: 56/56 passed. Railway deployment
`c36fd73a-b4a3-489d-9e46-ce52b8c7ac7f` passed the remote HTTP smoke:
unauthenticated calls 401, hidden tool 404, real division-by-zero repair verified,
and unsafe `import os` refused with PermissionError. The test is reproducible via
`scripts/smoke_platform_http.py`. Agent-side plugin import, credentials and the
repository canary have not yet passed; these transport tests are not platform
acceptance.
