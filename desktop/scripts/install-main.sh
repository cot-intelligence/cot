#!/usr/bin/env bash
# Install what's on origin/main the way a release would land on this Mac:
# build cot.app from a clean checkout of main, install it, then refresh the
# bridge and agent hooks from the new collector (what "Repair Agent Hooks…" runs).
#
#   scripts/install-main.sh
#
# Builds in a dedicated worktree next to the main checkout (../cot-release, or
# COT_RELEASE_DIR), reset to origin/main each run, so branches and uncommitted
# work in your own checkouts never reach the build. Ignored caches (node_modules,
# desktop/build/venv) are kept between runs. The app is unsigned, unlike CI's.
set -euo pipefail

REPO="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --path-format=absolute --git-common-dir)"
RELEASE_DIR="${COT_RELEASE_DIR:-$(dirname "$(dirname "${REPO}")")/cot-release}"
ENDPOINT="${COT_ENDPOINT:-http://127.0.0.1:31337}"

step() { printf '\n\033[1m› %s\033[0m\n' "$1"; }

step "Fetching origin/main"
git --git-dir="${REPO}" fetch origin main

if [ ! -d "${RELEASE_DIR}" ]; then
  step "Creating release worktree at ${RELEASE_DIR}"
  git --git-dir="${REPO}" worktree add --detach "${RELEASE_DIR}" origin/main
fi
cd "${RELEASE_DIR}"
git checkout -q --detach origin/main
git reset -q --hard origin/main
git clean -fdq
printf 'building %s\n' "$(git log -1 --format='%h %s')"

# main's own recipes, so the build matches the commit being installed.
just desktop deploy

step "Refreshing the bridge and agent hooks"
curl -fsSL "${ENDPOINT}/install.sh" | sh -s -- --repair
