$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Set-Location $PSScriptRoot

function Stage([string]$Message) { Write-Host "`n==> $Message" }
function Fail([string]$Message) { throw $Message }

Stage 'Verify repository'
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Fail 'git is required' }
$remote = (git remote get-url origin 2>$null)
if ($LASTEXITCODE -ne 0 -or -not $remote) { Fail 'Unable to read git origin' }
if ($remote -notmatch 'tocsindata/solari-cookbook(?:\.git)?$') { Fail "origin does not identify tocsindata/solari-cookbook: $remote" }
$branch = (git branch --show-current).Trim()
if ($branch -ne 'develop' -and -not $branch.StartsWith('develop/')) { Fail "Run development updates from develop or develop/* (current: $branch)" }

Stage 'Fast-forward source'
git fetch --prune origin
if ($LASTEXITCODE -ne 0) { Fail 'git fetch failed' }
git pull --ff-only origin $branch
if ($LASTEXITCODE -ne 0) { Fail 'git pull --ff-only failed' }

Stage 'Check runtime tools'
if (Test-Path 'package-lock.json') {
    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { Fail 'npm is required by package-lock.json' }
}
if ((Test-Path 'requirements.txt') -or (Test-Path 'pyproject.toml')) {
    if (-not (Get-Command python -ErrorAction SilentlyContinue)) { Fail 'python is required' }
}

if ((Test-Path 'requirements.txt') -or (Test-Path 'pyproject.toml')) {
    Stage 'Create Python environment'
    python -m venv .venv
    if ($LASTEXITCODE -ne 0) { Fail 'python -m venv failed' }
    $pythonExe = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
    & $pythonExe -m pip install --upgrade pip
    if ($LASTEXITCODE -ne 0) { Fail 'pip upgrade failed' }
} else {
    $pythonExe = 'python'
}

Stage 'Install dependencies'
if (Test-Path 'package-lock.json') { npm ci; if ($LASTEXITCODE -ne 0) { Fail 'npm ci failed' } }
if (Test-Path 'requirements.txt') { & $pythonExe -m pip install -r requirements.txt; if ($LASTEXITCODE -ne 0) { Fail 'pip install failed' } }
if (Test-Path 'requirements-dev.txt') { & $pythonExe -m pip install -r requirements-dev.txt; if ($LASTEXITCODE -ne 0) { Fail 'dev dependency install failed' } }

Stage 'Build and test'
if (Test-Path 'package.json') {
    $scripts = (npm run 2>&1 | Out-String)
    if ($scripts -match '(?m)^\s+build\b') { npm run build; if ($LASTEXITCODE -ne 0) { Fail 'npm build failed' } }
    if ($scripts -match '(?m)^\s+test\b') { npm test; if ($LASTEXITCODE -ne 0) { Fail 'npm test failed' } }
}
if (Test-Path 'tests') { & $pythonExe -m pytest; if ($LASTEXITCODE -ne 0) { Fail 'pytest failed' } }

Stage 'Configuration check'
if (-not $env:SOLARI_API_KEY) {
    Write-Host 'NOTE: SOLARI_API_KEY is not set. Non-live tests may run; live Solari tests must fail/skip explicitly rather than inventing credentials.'
}

Stage 'Update complete'
Write-Host "Repository: $remote"
Write-Host "Branch: $branch"
