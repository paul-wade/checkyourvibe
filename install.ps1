# Install checkyourvibe from a local clone.
#
# This script does not publish anything, does not edit your shell configuration,
# and does not require a registry account. It makes the local checkout usable so
# that `cyv` can be run from the built workspace.

param(
  [switch]$DryRun,
  [switch]$Help,
  # Catches anything that isn't -DryRun or -Help so an unrecognized flag is
  # rejected instead of silently falling through to the real install (which
  # runs pnpm install / pnpm build for real). install.sh already rejects
  # unknown arguments this way; this mirrors it.
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Unrecognized
)

function Show-Help {
  @'
Usage: install.ps1 [OPTIONS]

Install or refresh a local checkyourvibe checkout.

Options:
  -DryRun         Check prerequisites and print the cyv invocation path without
                  running pnpm install or pnpm build.
  -Help           Show this message and exit.

Prerequisites:
  - Node.js >= 20
  - pnpm
  - git (and the current directory must be inside the checkout)

The C# analyzer is optional: if dotnet is not installed, the script warns but
continues.
'@
}

if ($Help) {
  Show-Help | Write-Output
  exit 0
}

if ($Unrecognized -and $Unrecognized.Count -gt 0) {
  Write-Error "Unknown argument: $($Unrecognized[0])"
  Show-Help | Write-Error
  exit 2
}

function Fail($message, $detail) {
  Write-Error "Error: $message"
  if ($detail) {
    Write-Error "       $detail"
  }
  exit 1
}

function Warn($message, $detail) {
  Write-Warning $message
  if ($detail) {
    Write-Warning $detail
  }
}

# Verify Node.js >= 20 first; every later step depends on it.
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Fail "node is not installed" "Install Node.js 20 or later from https://nodejs.org/"
}

$nodeVersionRaw = node --version 2>$null
if (-not ($nodeVersionRaw -match '^v(\d+)')) {
  Fail "could not parse node version" "node --version returned: $nodeVersionRaw"
}

$nodeMajor = [int]$Matches[1]
if ($nodeMajor -lt 20) {
  Fail "node >= 20 is required" "Installed version: $nodeVersionRaw"
}

# Verify pnpm; the workspace is managed with pnpm and cannot be built without it.
$pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
if (-not $pnpm) {
  Fail "pnpm is not installed" "Install pnpm: https://pnpm.io/installation"
}

# Verify git is available and that the current directory is inside the checkout.
$git = Get-Command git -ErrorAction SilentlyContinue
if (-not $git) {
  Fail "git is not installed" "Install git and clone the repository"
}

$repoRoot = git rev-parse --show-toplevel 2>$null
if (-not $repoRoot) {
  Fail "not inside a git repository" "Run this script from inside the checkyourvibe checkout"
}

# The workspace file is the marker that this is the right git checkout.
$workspaceFile = Join-Path $repoRoot 'pnpm-workspace.yaml'
if (-not (Test-Path $workspaceFile)) {
  Fail "pnpm-workspace.yaml not found" "This does not look like the checkyourvibe repository"
}

# The C# analyzer is optional; a missing .NET toolchain should not block install.
$dotnet = Get-Command dotnet -ErrorAction SilentlyContinue
if (-not $dotnet) {
  Warn "dotnet is not installed." "The C# analyzer will be unavailable and .cs files will not be checked. Install the .NET SDK to use it. cyv check will report this clearly."
}

if ($DryRun) {
  Write-Output "Dry run: prerequisites satisfied."
  Write-Output "  node:    $nodeVersionRaw"
  Write-Output "  pnpm:    $(pnpm --version)"
  Write-Output "  repo:    $repoRoot"
  if ($dotnet) {
    Write-Output "  dotnet:  $(dotnet --version)"
  } else {
    Write-Output "  dotnet:  not installed (C# analyzer will be unavailable)"
  }
  Write-Output ""
  Write-Output "Once built, the cyv binary for this checkout will be at:"
  Write-Output "  $repoRoot/packages/core/dist/cli/index.js"
  Write-Output ""
  Write-Output "Run it directly with:"
  Write-Output "  node ""$repoRoot/packages/core/dist/cli/index.js"" <command>"
  Write-Output ""
  $cyvEntry = Join-Path $repoRoot 'packages/core/dist/cli/index.js'
  Write-Output "To make 'cyv' a bare command in this shell, add this to your PowerShell profile:"
  Write-Output "  function cyv { node ""$cyvEntry"" @args }"
  Write-Output ""
  exit 0
}

# pnpm install is idempotent: re-running it on an already-installed checkout
# refreshes the lockfile and downloads only what changed.
Push-Location $repoRoot
try {
  Write-Output "Installing workspace dependencies..."
  pnpm install
  if ($LASTEXITCODE -ne 0) {
    Fail "pnpm install failed" "Check the output above and resolve the reported error, then run install.ps1 again"
  }

  # The root build script runs the project-reference build and copies the JSON
  # schemas into the core package's dist/ directory. Skipping it leaves
  # `cyv verify-analyzer` and `cyv check` unable to find their schemas.
  Write-Output "Building workspace..."
  pnpm build
  if ($LASTEXITCODE -ne 0) {
    Fail "pnpm build failed" "Check the output above, fix the build error, then run install.ps1 again"
  }
} finally {
  Pop-Location
}

# Build the C# analyzer when the toolchain is present. Without its assembly the
# analyzer cannot start, so `cyv check --all` on this repository skips the .cs
# files and exits non-zero under --strict. A failure here warns rather than
# aborting, because the analyzer is optional.
#
# This sits after the dry-run branch has already exited. Placing it inside that
# branch made --dry-run compile a project, which is the one thing a dry run
# promises not to do.
if ($dotnet) {
  Write-Output "Building the C# analyzer..."
  Push-Location (Join-Path $repoRoot 'packages/analyzer-csharp/src')
  try {
    dotnet build -c Release --nologo -v quiet
    if ($LASTEXITCODE -ne 0) {
      Warn "the C# analyzer did not build." "cyv check will skip .cs files and say so. Build it later with: cd packages/analyzer-csharp/src; dotnet build -c Release"
    }
  } finally {
    Pop-Location
  }
}

$cyvEntry = Join-Path $repoRoot 'packages/core/dist/cli/index.js'
if (-not (Test-Path $cyvEntry)) {
  Fail "cyv entry point was not built" "Expected: $cyvEntry"
}

Write-Output ""
Write-Output "Installation complete."
Write-Output ""
Write-Output "Run cyv from this checkout with:"
Write-Output "  node ""$cyvEntry"" --help"
Write-Output ""
Write-Output "To make 'cyv' a bare command in this shell, add this to your PowerShell profile:"
Write-Output "  function cyv { node ""$cyvEntry"" @args }"
Write-Output ""
