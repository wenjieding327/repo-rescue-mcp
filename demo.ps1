$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$venvPython = Join-Path $repoRoot ".venv\Scripts\python.exe"

Set-Location -LiteralPath $repoRoot

if (-not (Test-Path -LiteralPath $venvPython)) {
    if (Get-Command py -ErrorAction SilentlyContinue) {
        & py -3 -m venv (Join-Path $repoRoot ".venv")
    } elseif (Get-Command python -ErrorAction SilentlyContinue) {
        & python -m venv (Join-Path $repoRoot ".venv")
    } else {
        throw "Python 3.11 or newer was not found."
    }
    if ($LASTEXITCODE -ne 0) { throw "Unable to create the RepoRescue virtual environment." }
}

$previousErrorActionPreference = $ErrorActionPreference
$ErrorActionPreference = "SilentlyContinue"
& $venvPython -c "import importlib.util, sys; required = ('repo_rescue', 'packaging', 'pytest'); sys.exit(0 if all(importlib.util.find_spec(name) is not None for name in required) else 1)" *> $null
$dependencyProbeExitCode = $LASTEXITCODE
$ErrorActionPreference = $previousErrorActionPreference
if ($dependencyProbeExitCode -ne 0) {
    Write-Host "Installing RepoRescue dependencies (first run only)..."
    & $venvPython -m pip install --disable-pip-version-check --no-input -q -e ".[dev]"
    if ($LASTEXITCODE -ne 0) { throw "RepoRescue dependency installation failed." }
}
& $venvPython -m repo_rescue demo --artifacts (Join-Path $repoRoot "artifacts")
if ($LASTEXITCODE -ne 0) { throw "RepoRescue interview demo failed." }
