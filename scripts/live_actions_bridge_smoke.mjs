#!/usr/bin/env node

import { GitHubActionsBridge } from "../actions-bridge.mjs";
import { fileURLToPath } from "node:url";

const CANARY_URL = "https://github.com/wenjieding327/repo-rescue-canary";
const MAX_POLLS_PER_STAGE = 90;
const MAX_HTTP_RESPONSE_BYTES = 32 * 1024 * 1024;
const JOB_STATUSES = new Set(["dispatching", "dispatch_unknown", "queued", "running", "collecting_artifact",
  "poll_deferred", "succeeded", "failed"]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export async function pollToTerminal(bridge, stage, initial, stderr = process.stderr) {
  assert(stage === "prepare" || stage === "verify", "Unexpected smoke stage.");
  let snapshot = initial;
  for (let attempt = 1; attempt <= MAX_POLLS_PER_STAGE; attempt += 1) {
    assert(snapshot?.ok === true && snapshot?.job?.job_id, `${stage} did not return a live job capability.`);
    assert(JOB_STATUSES.has(snapshot.job.status), "The job returned an unknown status.");
    if (snapshot.job.terminal === true) return snapshot;
    stderr.write(`${stage}: ${snapshot.job.status} (poll ${attempt})\n`);
    snapshot = await bridge.get(snapshot.job.job_id, 20);
  }
  throw new Error(`${stage} did not finish within the live smoke polling budget.`);
}

export async function main({ baseUrl = process.argv[2], environment = process.env, fetchImpl = fetch,
  stdout = process.stdout, stderr = process.stderr } = {}) {
  // Optional HTTP mode exercises the deployed plugin adapter, not a local bridge.
  const bridge = baseUrl ? httpBridge(baseUrl, {
    token: environment.REPO_RESCUE_HTTP_ACCESS_TOKEN, fetchImpl, stderr,
  }) : GitHubActionsBridge.fromEnvironment(environment);
  const preparation = await pollToTerminal(
    bridge,
    "prepare",
    await bridge.start("prepare", { repo_url: CANARY_URL }),
    stderr,
  );
  assert(preparation.job.status === "succeeded", "The live preparation job failed.");
  const prepared = preparation.job.result?.preparation;
  assert(preparation.job.result?.ok === true, "The live preparation result was not successful.");
  assert(prepared?.status === "repair_ready", "The canary preparation did not reach repair_ready.");
  assert(prepared?.repairable === true, "The canary did not produce a repairable baseline failure.");
  assert(prepared?.repository?.slug === "wenjieding327/repo-rescue-canary", "Preparation returned the wrong repository.");
  assert(/^[0-9a-f]{40}$/.test(prepared.repository.commit), "Preparation returned an invalid commit.");
  assert(/^[0-9a-f]{64}$/.test(prepared.baseline_sha256), "Preparation returned an invalid baseline hash.");
  assert(prepared?.baseline?.backend === "docker", "Preparation did not use the Docker verifier.");
  assert(prepared?.baseline?.command === "python -m pytest -q", "Preparation selected an unexpected command.");
  assert(prepared?.baseline?.execution?.exit_code === 1, "The fixed canary baseline did not exit with code 1.");
  assert(prepared?.baseline?.execution?.pytest_attestation?.passed === 2, "The fixed canary baseline did not pass two tests.");
  assert(prepared?.baseline?.execution?.pytest_attestation?.failed === 1, "The fixed canary baseline did not fail one test.");

  const verification = await pollToTerminal(
    bridge,
    "verify",
    await bridge.startVerify(preparation.job.job_id, {
      repo_url: CANARY_URL,
      expected_commit: prepared.repository.commit,
      expected_baseline_sha256: prepared.baseline_sha256,
      issue: "normalize_title should return untitled for a blank or whitespace-only title.",
      analysis: "The implementation strips and lowercases the value but does not apply its documented blank fallback.",
      changes: [
        {
          path: "src/repo_rescue_canary/parser.py",
          content: [
            '"""Small text normalization helper used by the RepoRescue canary."""',
            "",
            "",
            "def normalize_title(value: str) -> str:",
            '    """Normalize a title and use ``untitled`` when it is blank."""',
            "    normalized = value.strip().lower()",
            '    return normalized or "untitled"',
            "",
          ].join("\n"),
        },
      ],
    }),
    stderr,
  );
  assert(verification.job.status === "succeeded", "The live verification job failed.");
  const result = verification.job.result;
  const repair = result?.repair;
  const contents = result?.github_actions?.artifact_contents;
  const preparationActions = preparation.job.result?.github_actions;
  assert(result?.ok === true, "The live verification result was not successful.");
  assert(repair?.verified_repair === true && repair?.status === "verified_repair", "The canary repair was not verified.");
  assert(repair?.repository?.commit === prepared.repository.commit, "Verification changed the prepared repository commit.");
  assert(repair?.baseline?.preparation_baseline_sha256 === prepared.baseline_sha256, "Verification changed the prepared baseline hash.");
  assert(repair?.baseline?.execution?.exit_code === 1, "The original canary did not exit with code 1.");
  assert(repair?.final_verification?.execution?.exit_code === 0, "The repaired canary did not pass.");
  assert(
    repair.baseline.command === repair.final_verification.command,
    "The repaired canary was not checked with the original verification command.",
  );
  assert(repair.final_verification.command === "python -m pytest -q", "The fixed canary used an unexpected verification command.");
  assert(repair.final_verification.execution.pytest_attestation?.passed === 3, "The repaired canary did not pass all three tests.");
  assert(repair.final_verification.execution.pytest_attestation?.failed === 0, "The repaired canary still reported a failed test.");
  assert(
    JSON.stringify(repair.changed_files) === JSON.stringify(["src/repo_rescue_canary/parser.py"]),
    "The canary repair changed an unexpected file.",
  );
  assert(typeof contents?.patch === "string" && contents.patch.length > 0, "The verified artifact did not return a patch.");
  assert(typeof contents?.evidence === "string" && contents.evidence.length > 0, "The verified artifact did not return evidence.");
  assert(typeof contents?.report === "string" && contents.report.length > 0, "The verified artifact did not return a report.");
  const evidence = JSON.parse(contents.evidence);
  assert(evidence.run_id === repair.run_id, "Evidence returned a different run ID.");
  assert(evidence.status === repair.status && evidence.verified_repair === true, "Evidence returned a different repair verdict.");
  assert(evidence.patch_sha256 === repair.patch_sha256, "Evidence returned a different patch hash.");
  assert(result.github_actions?.files?.["repair.patch"]?.sha256 === repair.patch_sha256, "Artifact metadata returned a different patch hash.");
  assert(contents.report.includes(repair.run_id), "The report did not identify the verified repair run.");
  assert(preparationActions?.head_sha === result.github_actions?.head_sha, "Prepare and verify used different bridge commits.");
  const expectedHead = String(environment.REPO_RESCUE_ACTIONS_EXPECTED_HEAD_SHA || "").trim().toLowerCase();
  if (expectedHead) {
    assert(/^[0-9a-f]{40}$/.test(expectedHead), "REPO_RESCUE_ACTIONS_EXPECTED_HEAD_SHA is invalid.");
    assert(result.github_actions?.head_sha === expectedHead, "The live workflow did not use the expected bridge commit.");
  }

  // Only emit validated, public evidence identifiers. Job IDs are bearer capabilities.
  assert(Number.isSafeInteger(preparationActions?.workflow_run_id) && preparationActions.workflow_run_id > 0,
    "Preparation returned an invalid public run ID.");
  assert(Number.isSafeInteger(result.github_actions?.workflow_run_id) && result.github_actions.workflow_run_id > 0,
    "Verification returned an invalid public run ID.");
  assert(/^[0-9a-f]{40}$/.test(result.github_actions?.head_sha), "Verification returned an invalid bridge commit.");
  assert(/^[0-9a-f]{64}$/.test(repair.patch_sha256), "Verification returned an invalid patch hash.");
  stdout.write(`${JSON.stringify({
    ok: true,
    source_commit: prepared.repository.commit,
    baseline_sha256: prepared.baseline_sha256,
    prepare_run_id: preparation.job.result.github_actions?.workflow_run_id,
    verify_run_id: result.github_actions?.workflow_run_id,
    bridge_head_sha: result.github_actions?.head_sha,
    verification_status: repair.status,
    verification_command: repair.final_verification.command,
    before_exit: repair.baseline.execution.exit_code,
    after_exit: repair.final_verification.execution.exit_code,
    patch_sha256: repair.patch_sha256,
    artifact_url: `https://github.com/wenjieding327/repo-rescue-mcp/actions/runs/${result.github_actions.workflow_run_id}`,
  }, null, 2)}\n`);
}

export function httpBridge(baseUrl, { token, fetchImpl = fetch, stderr = process.stderr } = {}) {
  let base;
  try { base = new URL(baseUrl); } catch { throw new Error("The deployed smoke target is invalid."); }
  assert(base.protocol === "https:" && base.pathname === "/" && !base.username && !base.password && !base.search && !base.hash,
    "The deployed smoke target must be an HTTPS origin without credentials.");
  assert(typeof token === "string" && token.length >= 32 && token.length <= 4096 && /^[\x21-\x7e]+$/.test(token),
    "The gateway credential is missing or invalid.");
  async function call(name, args) {
    try {
      const response = await fetchImpl(new URL(`/api/tools/${name}`, base), {
        method: "POST",
        redirect: "error",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(args),
        signal: AbortSignal.timeout(90000),
      });
      assert(response.status === 200 && response.redirected !== true, "HTTP tool call did not succeed.");
      assert(/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") || ""),
        "HTTP tool call did not return JSON.");
      const reader = response.body?.getReader();
      assert(reader, "HTTP tool call returned no body.");
      const chunks = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          assert(size <= MAX_HTTP_RESPONSE_BYTES, "HTTP tool response exceeded the limit.");
          chunks.push(value);
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      const envelope = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      assert(envelope.is_error === false, "The HTTP tool returned a protocol error.");
      assert(typeof envelope.result_json === "string", "The HTTP tool returned an invalid envelope.");
      const payload = JSON.parse(envelope.result_json);
      assert((payload?.isError === undefined || payload.isError === false)
        && Array.isArray(payload?.content) && payload.content.length === 1
        && payload.content[0]?.type === "text" && typeof payload.content[0].text === "string",
      "The HTTP tool returned an invalid MCP result.");
      const result = JSON.parse(payload.content[0].text);
      assert(result && typeof result === "object" && !Array.isArray(result) && typeof result.ok === "boolean",
        "The HTTP tool returned an invalid job result.");
      return result;
    } catch {
      // Network/JSON error messages may contain credentials or capability-bearing response data.
      throw new Error("HTTP tool request failed.");
    }
  }
  return {
    start: async (stage, args) => {
      assert(stage === "prepare", "Unexpected preparation stage.");
      const refused = await call("start_prepare_github_repair", { repo_url: "https://github.com/example/not-allowed" });
      assert(refused.ok === false && !refused.job, "A non-allowlisted repository was not rejected before dispatch.");
      stderr.write("non-allowlist: rejected before dispatch\n");
      return call("start_prepare_github_repair", args);
    },
    get: (job_id, wait_seconds) => call("get_repair_job", { job_id, wait_seconds }),
    startVerify: (preparation_job_id, args) => call("start_verify_github_patch", { ...args, preparation_job_id }),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch(() => {
  // Do not echo SDK/network errors, which can include request credentials.
  process.stderr.write("live bridge smoke failed; no credentials or job capabilities were logged.\n");
  process.exitCode = 1;
});
