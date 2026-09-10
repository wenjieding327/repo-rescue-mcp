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

Outstanding: complete authenticated Agent integration and repeat the canary
prepare/poll/verify/poll from the actual Agent, then publish the existing Bot.
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
`scripts/smoke_platform_http.py`. These transport tests are not platform acceptance.

## Authenticated cloud canary checkpoint: 2026-09-09

The user-authorized, repository-scoped GitHub credential is now configured on
Railway. Deployment `91ded73c-2407-42d7-a59e-0c75d940f4a9` succeeded. No credential
value is stored in this repository. The adapter source is main
`134622c3dad50501eef72312417be142f9f1f530`; reliability CI `34353465679` passed.

The deployed HTTP adapter passed real snippet repair, unsafe import refusal,
authentication enforcement, hidden-tool refusal, and non-allowlist refusal
before dispatch. A real canary run also completed through the remote HTTP
prepare/poll/verify/poll endpoints:

- Canary commit: `04c26b6ee1b10e64336efffdf130716b52be0266`.
- Preparation Actions run: `34356887983`.
- Verification Actions run: `34356952270`.
- Same bridge commit: `134622c3dad50501eef72312417be142f9f1f530`.
- Docker baseline: `python -m pytest -q`, exit 1, two passed and one failed.
- Final verification: same command, exit 0, three passed and zero failed.
- `verified_repair=true`; only `src/repo_rescue_canary/parser.py` changed.
- Baseline SHA-256: `f0f1c35ddea53456e57f98e064e8474b6edf13c3d17d7f3be9bef462986de9e2`.
- Patch SHA-256: `08d04d2444bbfaa5d319343703c49c7461028b3a3f7b6eddf0a86a0973e7810a`.
- Artifact digest: `sha256:089e1de15dd2cbcf05f85cbd856d3cf9c2a733e8f143184f10794bbfc2e215c3`.
- Patch, evidence JSON, and report were retrieved and checked for consistent
  run identity, verdict, source commit, baseline hash, and patch hash.

Reproduce the remote canary smoke (the token stays in the injected environment):

```powershell
railway run --project <project> --environment production --service <service> -- node scripts/live_actions_bridge_smoke.mjs https://<host>
```

At this earlier checkpoint the full local Node suite again passed 56/56, but
the XFYun plugin draft had not yet passed platform-side testing. The later
personal-plugin checkpoint below supersedes that draft status. JSON parameter extraction works through
clipboard paste into the visible code area; ordinary textbox fill is incompatible
with this native-edit-context editor. Generated fields default to Query and
sample values, so switch top-level inputs to the actual JSON body and remove
sample defaults before testing. Do not publish the incomplete draft.

## XFYun personal-plugin verification: 2026-09-09

Four authenticated personal plugins were saved on XFYun: `rescue_snippet`,
`rescue_prepare`, `rescue_poll`, `rescue_verify`. Their top-level request
parameters use Body, and their responses expose `is_error` and `result_json`.
The API key is the dedicated gateway credential, never the GitHub credential.

Real XFYun plugin test pages verified division-by-zero repair, unsafe `import os`
refusal, and non-allowlist refusal. A canary prepare request from XFYun was
polled through the saved `rescue_poll` plugin (plugin ID `10225`). It returned
Docker baseline evidence: 2 passed, 1 failed. The proposed parser fallback was
then submitted through XFYun's `rescue_verify`, and the same poll plugin returned
`terminal=true`, `status=succeeded`, and `repair.verified_repair=true`, with
3 passed, 0 failed under the same `python -m pytest -q` command.

- Preparation run: `34361334463`.
- Verification run: `34362792272`.
- Canary commit: `04c26b6ee1b10e64336efffdf130716b52be0266`.
- Patch SHA-256: `63df94222b0b31d51ac46fa700e92689bfbde36e1624ac890df2af85a956a059`.
- Evidence SHA-256: `8de751b38a5b3fd469f5f0a8e665efd7dabbfc70cd553b49dff3730cfce8a9c1`.
- Only `src/repo_rescue_canary/parser.py` changed; tests were unchanged.

These are actual platform **tool** tests, not yet autonomous Agent acceptance.
The four plugins are now attached to workflow `648761` / Bot `5773337` in draft,
the obsolete hosted MCP URL was cleared, and the prompt was adapted to the HTTP
envelope with fail-closed evidence requirements. Independent Agent runs must
still pass before publishing the Bot. Historical debug conversations are not
valid evidence for this checkpoint.

## Evidence preservation and current blocker: 2026-09-10

The two XFYun tool-level Actions artifacts above were downloaded before their
one-day retention expired. The downloaded `repair.patch`, `evidence.json` and
`report.md` reproduce the recorded SHA-256 values exactly. Original bytes are
retained under ignored local `artifacts/platform-verification-2026-09-09/`;
these are tool-level evidence, not Agent publication evidence. Do not publish
private live job capabilities or gateway credentials with the material.

Public `/healthz` returned HTTP 200 on 2026-09-10. The local Node suite passed
56/56 again. Browser-control page reads timed out through both accessibility
and DOM interfaces; the user reports that the page is normally clickable.
This does not prove a XFYun service failure or a VPN cause. Until a current
Agent tool trace is available, no additional Agent acceptance is recorded.

The transport-specific configuration and unchanged full acceptance scope are
in [xfyun-http-agent-acceptance.md](xfyun-http-agent-acceptance.md).

The follow-up HTTP smoke hardening passed the complete local Node suite,
64/64, on 2026-09-10. Its eight additional mock tests cover origin validation,
redirect refusal, bounded/validated responses, fixed non-sensitive errors,
allow-listed polling status logs and public-only success identifiers. This is
local regression evidence, not a new remote canary or Agent acceptance.
