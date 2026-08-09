# RepoRescue — Verified Code Rescue

**Paste broken Python code or a public GitHub repository. RepoRescue explains it, generates a minimal repair, runs before-and-after verification, and reports exactly what the evidence proves.**

RepoRescue is not another “maybe try this” coding chatbot. Its differentiator is a verification protocol:

```text
understand intent → reproduce failure → generate minimal fix → run the same case again → grade the evidence
```

The product serves beginners through one low-friction entry point while keeping repository reproduction as the advanced mode:

| Mode | User provides | RepoRescue returns |
|---|---|---|
| Quick code rescue | A snippet, function, error, or assignment | Plain-language cause, repaired code, before/after run evidence |
| File rescue | A Python file or notebook | Structure, focused patch, tests, readable result |
| Project rescue | A public GitHub repository and optional issue description | Commit-pinned failure, generated source repair, same-command verification, patch and evidence bundle |

## Why it is different

- **Generated repair, not a checklist:** the agent produces the candidate code.
- **Before/after proof:** a fix is “verified” only when the original fails and the repaired version passes the same stated case.
- **Beginner-first result:** users see the cause, change, and outcome before technical logs.
- **Scoped claims:** snippet execution, repository tests, official demos, and paper metrics are different evidence levels.
- **Portable core:** the same MCP tools can power XFYun Agent, OpenClaw, Codex, or another agent shell.

## Backend repair architecture

```text
GitHub URL + issue
        │
        ▼
commit-pinned temporary checkout
        │
        ▼
Docker baseline verifier ── records failing command, exit code and logs
        │
        ▼
OpenAI Repair Agent ── proposes bounded non-test source replacements
        │
        ▼
safe patch application ── blocks traversal, test edits and Git metadata
        │
        ▼
same-command verifier ── retries up to the configured attempt limit
        │
        ▼
repair.patch + evidence.json + report.md
```

## Interview demo — one command, no API key

From PowerShell in the repository root:

```powershell
.\demo.ps1
```

On Windows, `demo.cmd` can also be double-clicked.

The script creates or reuses `.venv`, installs the project, and runs a seeded broken calculator through the real orchestration path. The original test exits `1`, the Repair Agent changes `calculator.py`, the exact same command exits `0`, and a timestamped evidence bundle is written under `artifacts/`.

This deterministic demo is intentionally limited to the bundled trusted project so it is reliable without Docker, network access, or model credentials. Public GitHub repositories use the Docker + OpenAI path below.

## Quick start: hosted Node MCP

The hosted launcher uses CPython WebAssembly for isolated snippet execution and for the allow-listed competition repository when native Python is unavailable.

```powershell
npm install
npm test
node .\stdio-server.mjs
```

### `rescue_python_snippet`

Supply original code and the AI-generated candidate. Optional cases provide stdin and expected stdout.

```json
{
  "original_code": "numbers = [1, 2, 3]\nprint(numbers[3])",
  "candidate_code": "numbers = [1, 2, 3]\nprint(numbers[-1])",
  "test_cases": [
    {"name": "last item", "stdin": "", "expected_stdout": "3"}
  ]
}
```

The response records the original `IndexError`, the repaired output, case-level status, and a scoped `S2`/`L1_SNIPPET_EXECUTION` result. It never claims a whole project or paper was reproduced from this snippet run.

## Full repository Repair Agent

The Python backend provides repository inspection, container-backed reproduction, repository repair orchestration, verification and artifact output:

```powershell
py -3.11 -m venv .venv
.venv\Scripts\python -m pip install -e ".[dev,agent]"
.venv\Scripts\python -m pytest
docker build -f sandbox/Dockerfile.python311 -t repo-rescue-python:3.11 .

$env:OPENAI_API_KEY="your-api-key"
$env:REPO_RESCUE_ALLOWED_REPOS="owner/broken-repository"
.venv\Scripts\repo-rescue repair `
  https://github.com/owner/broken-repository `
  --issue "describe the observed failure" `
  --artifacts .\artifacts
```

The repair command uses the [OpenAI Responses API](https://developers.openai.com/api/docs/guides/latest-model). `REPO_RESCUE_OPENAI_MODEL` selects the model and defaults to `gpt-5.6-terra`. The repository must be public and explicitly allow-listed; arbitrary shell commands are never accepted.

To expose the same workflow as MCP, run `.venv\Scripts\repo-rescue-mcp`. The Streamable HTTP endpoint defaults to `http://localhost:8000/mcp`; set `REPO_RESCUE_TRANSPORT=stdio` for a command-based host.

## Repository tools

### `inspect_github_project`

Read-only inspection of an allow-listed public repository. Returns the exact commit, bounded file tree, Python manifests, dependency declarations, version hints, risks, entry points, and suggested verification commands.

### `reproduce_python_project`

Runs a fixed verification scope for an explicitly allow-listed Python repository and returns the actual command, exit code, duration, test counts, bounded logs, backend, and attestation. The result states whether it was a smoke test, selected suite, or broader run.

### `repair_github_project`

Runs the full repository loop: commit-pinned clone, Docker baseline, bounded Repair Agent proposal, protected source replacement, identical-command verification, retry, and durable evidence artifacts. It never pushes or opens a pull request.

### `run_interview_demo`

Runs the deterministic end-to-end demonstration through MCP without Docker or an API key. This is the safest live interview entry point.

### `windows_environment_probe`

Returns a copy-paste PowerShell probe. It never claims to read a user's computer automatically and does not change the machine.

## Evidence levels

- **S1:** snippet executed.
- **S2:** original snippet failed and repaired snippet passed the same case.
- **P1:** repository and commit inspected; no execution claim.
- **P2:** dependencies resolved.
- **P3:** named repository test scope executed with recorded exit code.
- **P4:** documented official demo reproduced.
- **P5:** paper metric reproduced under a stated dataset, configuration, seed, and hardware boundary.

Current hosted competition evidence reaches **S2** for safe Python snippets and **P3 for the named core smoke scope** on the allow-listed demo. It does not claim P4 or P5.

## Verified Code Rescue Skill

[`skills/verified-code-rescue/SKILL.md`](skills/verified-code-rescue/SKILL.md) packages the distinctive orchestration protocol for agent hosts. It routes snippets, files, and repositories; requires before/after evidence; grades the claim scope; and produces a beginner-readable answer before technical details.

This Skill is intentionally not a generic coding prompt. Its reusable value is the truth-preserving rescue workflow.

## Safety boundary

- Snippet rescue limits source size and case count, permits only a small safe standard-library import set, rejects filesystem/process/network capabilities, and applies a deterministic execution budget.
- Repository execution remains allow-listed and constrained.
- Model output can replace only existing bounded source/config files; test edits, path traversal, symlinks and Git metadata are rejected.
- A repair is verified only when the pinned original fails and the modified checkout passes the exact same recorded command.
- The service does not read a user's computer, accept arbitrary shell commands, or execute private repositories.
- Public production should move untrusted repositories to gVisor or Firecracker, authenticate and rate-limit callers, scan archives, restrict outbound installation traffic, and expire stored source and logs.

## Portfolio summary

> Built a backend Repair Agent that accepts a public GitHub repository, creates a commit-pinned isolated checkout, reproduces a real failure, generates and safely applies a bounded source repair, reruns the exact same verifier, and emits a patch plus machine-readable and human-readable evidence. Exposed the loop through CLI and MCP while preventing test tampering and unverified success claims.

## Roadmap

- File and notebook upload with focused test generation.
- Dependency-conflict rescue with lockfile output.
- Web job dashboard and downloadable artifact bundle.
- Official-demo (`P4`) benchmark cases beyond the bundled interview fixture.
- Optional GitHub Issue/PR output after explicit user confirmation.
