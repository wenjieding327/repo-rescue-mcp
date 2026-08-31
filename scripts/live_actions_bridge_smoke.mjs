#!/usr/bin/env node

import { GitHubActionsBridge } from "../actions-bridge.mjs";

const CANARY_URL = "https://github.com/wenjieding327/repo-rescue-canary";
const MAX_POLLS_PER_STAGE = 90;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function pollToTerminal(bridge, stage, initial) {
  let snapshot = initial;
  for (let attempt = 1; attempt <= MAX_POLLS_PER_STAGE; attempt += 1) {
    assert(snapshot?.ok === true && snapshot?.job?.job_id, `${stage} did not return a live job capability.`);
    if (snapshot.job.terminal === true) return snapshot;
    process.stderr.write(`${stage}: ${snapshot.job.status} (poll ${attempt})\n`);
    snapshot = await bridge.get(snapshot.job.job_id, 20);
  }
  throw new Error(`${stage} did not finish within the live smoke polling budget.`);
}

async function main() {
  const bridge = GitHubActionsBridge.fromEnvironment(process.env);
  const preparation = await pollToTerminal(
    bridge,
    "prepare",
    await bridge.start("prepare", { repo_url: CANARY_URL }),
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
  assert(repair?.baseline?.execution?.exit_code !== 0, "The original canary did not fail.");
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
  const expectedHead = String(process.env.REPO_RESCUE_ACTIONS_EXPECTED_HEAD_SHA || "").trim().toLowerCase();
  if (expectedHead) {
    assert(/^[0-9a-f]{40}$/.test(expectedHead), "REPO_RESCUE_ACTIONS_EXPECTED_HEAD_SHA is invalid.");
    assert(result.github_actions?.head_sha === expectedHead, "The live workflow did not use the expected bridge commit.");
  }

  process.stdout.write(`${JSON.stringify({
    ok: true,
    source_commit: prepared.repository.commit,
    baseline_sha256: prepared.baseline_sha256,
    prepare_job_id: preparation.job.job_id,
    prepare_run_id: preparation.job.result.github_actions?.workflow_run_id,
    verify_job_id: verification.job.job_id,
    verify_run_id: result.github_actions?.workflow_run_id,
    bridge_head_sha: result.github_actions?.head_sha,
    verification_status: repair.status,
    verification_command: repair.final_verification.command,
    before_exit: repair.baseline.execution.exit_code,
    after_exit: repair.final_verification.execution.exit_code,
    patch_sha256: repair.patch_sha256,
    artifact_digest: result.github_actions?.artifact_digest,
    artifact_files: result.github_actions?.files,
    artifact_url: result.github_actions?.html_url,
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`live bridge smoke failed: ${String(error?.message || error).slice(0, 1_000)}\n`);
  process.exitCode = 1;
});
