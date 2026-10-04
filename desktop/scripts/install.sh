#!/usr/bin/env bash
# Install a built cot.app into /Applications and relaunch it.
#
#   scripts/install.sh [path/to/cot.app]   default: the last `just desktop build`
#
# Order matters: quit the running app, wait until both the shell and its
# collector have exited (quit returns early, and an `open` while the old
# process lingers gets swallowed), keep the old app in ~/cot-app-backups,
# copy the new one in, open it, and wait for the collector on 31337.
set -euo pipefail

DESKTOP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NEW="${1:-${DESKTOP_DIR}/src-tauri/target/release/bundle/macos/cot.app}"
DEST="/Applications/cot.app"
BACKUPS="${COT_APP_BACKUPS:-${HOME}/cot-app-backups}"
ENDPOINT="${COT_ENDPOINT:-http://127.0.0.1:31337}"

step() { printf '\n\033[1m› %s\033[0m\n' "$1"; }
version_of() { /usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$1/Contents/Info.plist" 2>/dev/null || echo unknown; }

[ -d "${NEW}" ] || { echo "no app at ${NEW}; run: just desktop build" >&2; exit 1; }
printf 'installing cot %s from %s\n' "$(version_of "${NEW}")" "${NEW}"

wait_gone() {
  local name="$1" i=0
  while pgrep -x "${name}" >/dev/null; do
    i=$((i + 1))
    [ "${i}" -le 60 ] || { echo "${name} is still running after 30s; quit cot and retry" >&2; exit 1; }
    sleep 0.5
  done
}

if pgrep -x cot-desktop >/dev/null; then
  step "Quitting the running app"
  osascript -e 'quit app "cot"' >/dev/null 2>&1 || true
  wait_gone cot-desktop
  wait_gone cot-collector
fi

if [ -d "${DEST}" ]; then
  step "Backing up the installed app"
  mkdir -p "${BACKUPS}"
  backup="${BACKUPS}/cot-$(version_of "${DEST}")-$(date +%Y%m%d-%H%M%S).app"
  mv "${DEST}" "${backup}"
  printf 'kept %s\n' "${backup}"
fi

step "Installing"
ditto "${NEW}" "${DEST}"
open "${DEST}"

step "Waiting for the collector"
i=0
until curl -fsS -m 2 "${ENDPOINT}/health" 2>/dev/null; do
  i=$((i + 1))
  # The app restarts a collector that isn't healthy within 15s; give it a few rounds.
  [ "${i}" -le 60 ] || { echo "collector did not answer at ${ENDPOINT} within 60s" >&2; exit 1; }
  sleep 1
done
printf '\n\033[1mcot %s is running\033[0m\n' "$(version_of "${DEST}")"
