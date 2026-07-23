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
| Project rescue | A public GitHub repository | Commit-pinned inspection, constrained execution, test evidence, reproduction boundary |

## Why it is different

- **Generated repair, not a checklist:** the agent produces the candidate code.
- **Before/after proof:** a fix is “verified” only when the original fails and the repaired version passes the same stated case.
- **Beginner-first result:** users see the cause, change, and outcome before technical logs.
- **Scoped claims:** snippet execution, repository tests, official demos, and paper metrics are different evidence levels.
- **Portable core:** the same MCP tools can power XFYun Agent, OpenClaw, Codex, or another agent shell.

## Live competition architecture

```text
User code / error / GitHub URL
              │
              ▼
     Generative agent decision
       ├─ explain and repair
       └─ select verification path
              │
              ▼
        RepoRescue MCP tools
       ├─ rescue_python_snippet
       ├─ inspect_github_project
       ├─ reproduce_python_project
       └─ windows_environment_probe
              │
              ▼
  readable result + diff + scoped evidence
```

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

## Local Python MCP

The Python server provides repository inspection and container-backed reproduction:

```powershell
py -3.11 -m venv .venv
.venv\Scripts\python -m pip install -e ".[dev]"
.venv\Scripts\pytest
docker build -f sandbox/Dockerfile.python311 -t repo-rescue-python:3.11 .

$env:REPO_RESCUE_ALLOWED_REPOS="pallets/click"
.venv\Scripts\repo-rescue-mcp
```

The Streamable HTTP endpoint defaults to `http://localhost:8000/mcp`. Set `REPO_RESCUE_TRANSPORT=stdio` for a command-based host.

## Repository tools

### `inspect_github_project`

Read-only inspection of an allow-listed public repository. Returns the exact commit, bounded file tree, Python manifests, dependency declarations, version hints, risks, entry points, and suggested verification commands.

### `reproduce_python_project`

Runs a fixed verification scope for an explicitly allow-listed Python repository and returns the actual command, exit code, duration, test counts, bounded logs, backend, and attestation. The result states whether it was a smoke test, selected suite, or broader run.

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
- The service does not read a user's computer, accept arbitrary shell commands, or execute private repositories.
- Public production should move untrusted repositories to gVisor or Firecracker, authenticate and rate-limit callers, scan archives, restrict outbound installation traffic, and expire stored source and logs.

## Portfolio summary

> Built a portable MCP-backed code rescue agent that combines generative debugging with constrained before/after execution, evidence-level grading, commit-pinned repository inspection, and verifiable test reports. Integrated the same tool layer with XFYun Agent and an agent-host Skill while preventing unexecuted AI suggestions from being presented as verified fixes.

## Roadmap

- File and notebook upload with focused test generation.
- Dependency-conflict rescue with lockfile output.
- Patch application and rerun loop for repositories.
- Official-demo (`P4`) case and downloadable reproduction report.
- Optional GitHub Issue/PR output after explicit user confirmation.
