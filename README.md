# RepoRescue MCP

RepoRescue turns a public GitHub URL into evidence that an agent can reason over. It can:

- clone a public GitHub repository with strict URL and size limits;
- identify Python manifests, declared dependencies, version hints, test runners and likely entry points;
- return source-linked evidence instead of invented environment facts;
- run allow-listed demonstration repositories inside constrained Docker containers;
- separate dependency installation from execution, then disable networking for the execution phase;
- produce bounded, redacted logs suitable for a verification report.

The service deliberately **does not** read a user's computer, accept arbitrary shell commands, execute private repositories, or execute repositories that are not explicitly allow-listed.

## Local setup

```powershell
py -3.11 -m venv .venv
.venv\Scripts\python -m pip install -e ".[dev]"
.venv\Scripts\pytest
docker build -f sandbox/Dockerfile.python311 -t repo-rescue-python:3.11 .
```

Run the Streamable HTTP MCP endpoint:

```powershell
$env:REPO_RESCUE_ALLOWED_REPOS="pallets/click"
.venv\Scripts\repo-rescue-mcp
```

The MCP endpoint is exposed at `http://localhost:8000/mcp` by the official Python MCP SDK.

For a command-based managed MCP host, set `REPO_RESCUE_TRANSPORT=stdio` and run `repo-rescue-mcp`. The same executable defaults to Streamable HTTP for local or self-hosted use.

## Tools

### `inspect_github_project`

Read-only inspection for a public GitHub repository. Returns repository identity, commit SHA, bounded file tree, Python manifests, declared dependencies, version hints, risks and suggested verification commands.

### `reproduce_python_project`

Runs an allow-listed Python repository in two Docker phases:

1. dependency installation in an empty ephemeral workspace;
2. execution in a separate container with networking disabled.

No host secrets or Docker socket are mounted into the target container. CPU, memory, process count, filesystem and runtime are constrained. The result contains actual exit codes and logs; success is never inferred.

The dedicated sandbox image contains only the baseline test runner and common terminal pager needed by the verified demo. Repository-specific dependencies are still resolved from the inspected manifest; the execution phase remains offline.

For a managed MCP host that cannot start Docker, set `REPO_RESCUE_EXECUTION_BACKEND=direct`. This fallback still accepts only explicitly allow-listed repositories and fixed verification commands, uses a temporary workspace, bounds time and output, and never exposes arbitrary shell execution. It is intentionally less isolated than the Docker backend and must not be enabled for untrusted public execution.

### `windows_environment_probe`

Returns a copy-paste PowerShell command for users who need local-environment evidence. It only reads versions and package metadata.

## Production boundary

Docker is adequate for an allow-listed competition demo, not for arbitrary hostile code. A public production service should replace Docker with a stronger isolation boundary such as gVisor or Firecracker, enforce outbound egress allow-lists during installation, scan uploaded archives, authenticate callers, rate-limit jobs and store no source after the job expires.
