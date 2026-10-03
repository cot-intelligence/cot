#!/usr/bin/env bash
# Build cot.app with Tauri.
#
#   scripts/build.sh              .app only
#   scripts/build.sh --dmg        .app and .dmg
#   scripts/build.sh --release    .app, .dmg and updater artifacts (.tar.gz + .sig);
#                                 needs TAURI_SIGNING_PRIVATE_KEY(_PASSWORD)
#
# The version comes from backend/app/__init__.py, the one version source for the
# collector, the Docker image and the app.
set -euo pipefail

DESKTOP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "${DESKTOP_DIR}/.." && pwd)"

VERSION="$(sed -n 's/^__version__ = "\(.*\)"$/\1/p' "${REPO_ROOT}/backend/app/__init__.py")"
[ -n "${VERSION}" ] || { echo "could not read backend/app/__init__.py version" >&2; exit 1; }

bundles="app"
config="{\"version\": \"${VERSION}\"}"
case "${1:-}" in
  "") ;;
  --dmg) bundles="app,dmg" ;;
  --release)
    bundles="app,dmg"
    config="{\"version\": \"${VERSION}\", \"bundle\": {\"createUpdaterArtifacts\": true}}"
    ;;
  *) echo "unknown flag: $1 (--dmg|--release)" >&2; exit 2 ;;
esac

"${DESKTOP_DIR}/scripts/prepare-collector.sh"

cd "${DESKTOP_DIR}"
[ -d node_modules ] || npm ci
# The bundler shells out to `xattr -cr`; a pip-installed xattr earlier on PATH
# (Homebrew) doesn't take -r, so put Apple's tools first.
PATH="/usr/bin:${PATH}" npx tauri build --bundles "${bundles}" --config "${config}"

printf '\n\033[1mBuilt cot %s\033[0m\n' "${VERSION}"
ls -1 "${DESKTOP_DIR}/src-tauri/target/release/bundle/"*/ 2>/dev/null | sed 's/^/  /'
