#!/usr/bin/env bash
#
# Install checkyourvibe from a local clone.
#
# This script does not publish anything, does not edit your shell configuration,
# and does not require a registry account. It makes the local checkout usable so
# that `cyv` can be run from the built workspace.

set -o pipefail

show_help() {
  cat <<'EOF'
Usage: install.sh [OPTIONS]

Install or refresh a local checkyourvibe checkout.

Options:
  --help, -h      Show this message and exit.
  --dry-run       Check prerequisites and print the cyv invocation path without
                  running pnpm install or pnpm build.

Prerequisites:
  - Node.js >= 20
  - pnpm
  - git (and the current directory must be inside the checkout)

The C# analyzer is optional: if dotnet is not installed, the script warns but
continues.
EOF
}

DRY_RUN=false

for arg in "$@"; do
  case "$arg" in
    --help|-h)
      show_help
      exit 0
      ;;
    --dry-run)
      DRY_RUN=true
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      show_help >&2
      exit 2
      ;;
  esac
done

fail() {
  echo "Error: $1" >&2
  if [ -n "$2" ]; then
    echo "       $2" >&2
  fi
  exit 1
}

warn() {
  echo "Warning: $1" >&2
  if [ -n "$2" ]; then
    echo "         $2" >&2
  fi
}

# Verify Node.js >= 20 first; every later step depends on it.
if ! command -v node >/dev/null 2>&1; then
  fail "node is not installed" "Install Node.js 20 or later from https://nodejs.org/"
fi

NODE_VERSION=$(node --version 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/')
if [ -z "$NODE_VERSION" ] || [ "$NODE_VERSION" -lt 20 ]; then
  fail "node >= 20 is required" "Installed version: $(node --version 2>/dev/null || echo 'unknown')"
fi

# Verify pnpm; the workspace is managed with pnpm and cannot be built without it.
if ! command -v pnpm >/dev/null 2>&1; then
  fail "pnpm is not installed" "Install pnpm: https://pnpm.io/installation"
fi

# Verify git is available and that the current directory is inside the checkout.
if ! command -v git >/dev/null 2>&1; then
  fail "git is not installed" "Install git and clone the repository"
fi

REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
if [ -z "$REPO_ROOT" ]; then
  fail "not inside a git repository" "Run this script from inside the checkyourvibe checkout"
fi

# The workspace file is the marker that this is the right git checkout.
if [ ! -f "$REPO_ROOT/pnpm-workspace.yaml" ]; then
  fail "pnpm-workspace.yaml not found" "This does not look like the checkyourvibe repository"
fi

# The C# analyzer is optional; a missing .NET toolchain should not block install.
if ! command -v dotnet >/dev/null 2>&1; then
  warn "dotnet is not installed." "The C# analyzer will be unavailable and .cs files will not be checked. Install the .NET SDK to use it. cyv check will report this clearly."
fi

if [ "$DRY_RUN" = true ]; then
  echo "Dry run: prerequisites satisfied."
  echo "  node:    $(node --version)"
  echo "  pnpm:    $(pnpm --version)"
  echo "  repo:    $REPO_ROOT"
  if command -v dotnet >/dev/null 2>&1; then
    echo "  dotnet:  $(dotnet --version)"
  else
    echo "  dotnet:  not installed (C# analyzer will be unavailable)"
  fi
  echo ""
  echo "Once built, the cyv binary for this checkout will be at:"
  echo "  $REPO_ROOT/packages/core/dist/cli/index.js"
  echo ""
  echo "Run it directly with:"
  echo "  node \"$REPO_ROOT/packages/core/dist/cli/index.js\" <command>"
  echo ""
  echo "To make 'cyv' a bare command in this shell, add this to your shell rc:"
  echo "  cyv() { node \"$REPO_ROOT/packages/core/dist/cli/index.js\" \"\$@\"; }"
  echo ""
  exit 0
fi

cd "$REPO_ROOT" || fail "could not enter repository root" "$REPO_ROOT"

# pnpm install is idempotent: re-running it on an already-installed checkout
# refreshes the lockfile and downloads only what changed.
echo "Installing workspace dependencies..."
if ! pnpm install; then
  fail "pnpm install failed" "Check the output above and resolve the reported error, then run install.sh again"
fi

# The root build script runs the project-reference build and copies the JSON
# schemas into the core package's dist/ directory. Skipping it leaves
# `cyv verify-analyzer` and `cyv check` unable to find their schemas.
echo "Building workspace..."
if ! pnpm build; then
  fail "pnpm build failed" "Check the output above, fix the build error, then run install.sh again"
fi

# Build the C# analyzer when the toolchain is present. Without its assembly the
# analyzer cannot start, so `cyv check --all` on this repository skips four .cs
# files and exits non-zero under --strict. The warning above covers the case
# where dotnet is absent; this covers the case where it is installed and the
# assembly simply was never built.
if command -v dotnet >/dev/null 2>&1; then
  echo "Building the C# analyzer..."
  if ! (cd "$REPO_ROOT/packages/analyzer-csharp/src" && dotnet build -c Release --nologo -v quiet); then
    warn "the C# analyzer did not build." "cyv check will skip .cs files and say so. Build it later with: cd packages/analyzer-csharp/src && dotnet build -c Release"
  fi
fi

CYV_ENTRY="$REPO_ROOT/packages/core/dist/cli/index.js"
if [ ! -f "$CYV_ENTRY" ]; then
  fail "cyv entry point was not built" "Expected: $CYV_ENTRY"
fi

echo ""
echo "Installation complete."
echo ""
echo "Run cyv from this checkout with:"
echo "  node \"$CYV_ENTRY\" --help"
echo ""
echo "To make 'cyv' a bare command in this shell, add this to your shell rc:"
echo "  cyv() { node \"$CYV_ENTRY\" \"\$@\"; }"
echo ""
