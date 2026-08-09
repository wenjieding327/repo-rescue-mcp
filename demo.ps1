$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$venvPython = Join-Path $repoRoot ".venv\Scripts\python.exe"

Set-Location -LiteralPath $repoRoot

if (-not (Test-Path -LiteralPath $venvPython)) {
    py -3.11 -m venv (Join-Path $repoRoot ".venv")
}

& $venvPython -m pip install --disable-pip-version-check -q -e ".[dev]"
& $venvPython -m repo_rescue demo --artifacts (Join-Path $repoRoot "artifacts")
