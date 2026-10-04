#!/usr/bin/env bash
# Try the web install the way a new user gets it, without touching your own
# cot: `curl -fsSL https://cot.run/install | sh` runs with HOME pointed at a
# throwaway directory, so the collector container, ~/.cot (database, bridge,
# config) and the agent hook files all land in the sandbox.
#
#   scripts/fresh-install.sh              collector image built from origin/main
#   scripts/fresh-install.sh --release    the published image (what users pull today)
#   scripts/fresh-install.sh down         remove the container and the sandbox
#
#   COT_FRESH_HISTORY=1   import your real Claude/Cursor/Codex transcripts (read only)
#   COT_FRESH_PORT=31390  collector port; COT_FRESH_DIR sandbox path
#
# Your agents still read your real hook files, so live sessions keep going to
# your own collector; the sandbox shows onboarding, import and the dashboard.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SANDBOX="${COT_FRESH_DIR:-${TMPDIR:-/tmp}/cot-fresh}"
PORT="${COT_FRESH_PORT:-31390}"
CONTAINER="cot-fresh"
LOCAL_IMAGE="cot-fresh:main"
RELEASE_IMAGE="ghcr.io/cot-intelligence/cot:latest"

step() { printf '\n\033[1m› %s\033[0m\n' "$1"; }

down() {
  docker rm -f "${CONTAINER}" >/dev/null 2>&1 || true
  rm -rf "${SANDBOX}"
  printf 'removed %s and %s\n' "${CONTAINER}" "${SANDBOX}"
}

case "${1:-}" in
  down) down; exit 0 ;;
  --release) image="${RELEASE_IMAGE}" ;;
  "")
    step "Building the collector image from origin/main"
    git -C "${REPO_ROOT}" fetch origin main
    git -C "${REPO_ROOT}" archive origin/main | docker build -q -f Dockerfile.app -t "${LOCAL_IMAGE}" -
    image="${LOCAL_IMAGE}"
    ;;
  *) echo "usage: $0 [--release|down]" >&2; exit 2 ;;
esac

step "Resetting the sandbox at ${SANDBOX}"
down
mkdir -p "${SANDBOX}/home"

if [ "${COT_FRESH_HISTORY:-0}" = 1 ]; then
  # Transcript roots only; hooks and ~/.cot still go to the sandbox HOME.
  export COT_CLAUDE_HOME="${HOME}/.claude" COT_CURSOR_HOME="${HOME}/.cursor" COT_CODEX_HOME="${HOME}/.codex"
fi

step "Running the cot.run installer as a new user"
curl -fsSL https://cot.run/install \
  | HOME="${SANDBOX}/home" COT_CONTAINER="${CONTAINER}" COT_IMAGE="${image}" COT_PORT="${PORT}" sh

printf '\n\033[1mFresh install running\033[0m\n'
printf '  dashboard  %s\n' "$(cat "${SANDBOX}/home/.cot/config.json" 2>/dev/null | sed -n 's/.*"endpoint"[^"]*"\([^"]*\)".*/\1/p' | head -n1)"
printf '  sandbox    %s\n' "${SANDBOX}/home"
printf '  remove     just fresh down\n'
