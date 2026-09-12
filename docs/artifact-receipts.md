# Original artifact delivery

The HTTP gateway separates the model's short explanation from the actual repair files. A verified terminal `get_repair_job` response can include a top-level `receipt_url`. For compatibility with existing XFYun plugins that expose only `is_error` and `result_json`, the gateway also mirrors the same value as the root `receipt_url` field inside the JSON string. Every existing MCP result field and `content` value remains unchanged; `receipt_url` is a reserved additive gateway field. Other operations, incomplete jobs, MCP tool-envelope errors and unverified repairs return an empty receipt URL in both locations; transport-level rejections use their own error envelope and mint no receipt.

The Agent relays the exact URL and does not retype patches or long hashes. The receipt serves the original GitHub ZIP and its four files: `result.json`, `repair.patch`, `evidence.json`, and `report.md`. File bodies are original Buffers, including byte-order marks, indentation and line endings. The HTML page calculates SHA-256 from those bytes and escapes all untrusted text.

## Configuration and access

- The public origin defaults to `https://reporescue-mcp-production.up.railway.app`. An explicit `REPO_RESCUE_PUBLIC_ORIGIN` must be a bare HTTPS origin; request Host headers never select it.
- Receipt signing derives a separate HMAC key from the existing gateway access token. Receipt URLs contain no PAT or gateway credential. Rotating the gateway key invalidates old receipts.
- A receipt is a read-only share capability. Anyone holding it may download that run's artifacts, but cannot call execution tools or start a job. Receipts are limited to the reviewed public repositories and are not generated for user code snippets.
- The authenticated execution API and SSE retain their existing bearer and Origin checks. Only the signed receipt routes allow browser reads. No CORS execution permission is added.

## Validation and lifetime

Signature validation happens before any provider request. The loader fixes the control repository, protected branch and workflow, then validates run identity, attempt, source head, artifact identity, expiry, ZIP digest and the cross-bound verification evidence. It checks the source repository is still public and rejects credential-bearing artifact contents.

The existing Actions workflow retains artifacts for one day. This delivery change deliberately leaves that workflow unchanged and needs no new GitHub workflow permission. Receipt expiry is capped by the artifact's actual expiry and a maximum of seven days from issuance, so current new artifacts remain available for at most about one day. The page shows its actual expiry. Deleted artifacts, invalid credentials and inaccessible providers produce a controlled unavailable response, never a reconstructed substitute.

Links survive gateway restarts with the same signing key because artifacts are reloaded from GitHub, not an in-memory job or local disk. An in-memory cache lasts at most five minutes and 32 MiB; removal or privacy changes may therefore take up to five minutes to affect an already cached receipt. Reads are limited to 120 requests per minute globally and at most two concurrent distinct artifact loads. Cache is not permanent storage.

For competition review, download and include the original files, an offline receipt snapshot and an independent byte/hash check in the submission package. Online receipt lifetime is not a substitute for offline evidence. September 2026 competition judging extends beyond the online artifact lifetime.

## Verification status

This is an implementation candidate until a fresh platform autonomous repair returns a real receipt, downloads match the original ZIP, and the same published Bot's public entry passes validation. Unit tests and historical offline compatibility checks do not constitute publication evidence.
