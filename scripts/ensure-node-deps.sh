#!/usr/bin/env bash
# Install a package's node_modules when they're missing or older than its
# package-lock.json (e.g. after a dependency bump was merged), so builds never
# run on stale packages.
#
#   scripts/ensure-node-deps.sh [dir]   default: the repo root
#
# npm writes node_modules/.package-lock.json on every install; a lockfile newer
# than that means the install predates the current dependencies.
set -euo pipefail

DIR="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "${DIR}"
[ -f package-lock.json ] || exit 0

if [ ! -d node_modules ] || [ ! -f node_modules/.package-lock.json ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
  printf 'installing node packages in %s (lockfile changed)\n' "${DIR}"
  npm ci --no-audit --no-fund
fi
