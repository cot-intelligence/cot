#!/usr/bin/env bash
# Build cot.app with Tauri.
#
#   scripts/build.sh              .app only
#   scripts/build.sh --dmg        .app and .dmg
#   scripts/build.sh --release    .app, .dmg and updater artifacts (.tar.gz + .sig);
#                                 needs TAURI_SIGNING_PRIVATE_KEY(_PASSWORD)
#   scripts/build.sh --sandbox    .app and .dmg as "cot Sandbox": test icon, own bundle id,
#                                 empty HOME (fresh onboarding); see README
#   scripts/build.sh --shell      .app only, reusing the frozen collector: rebuilds the
#                                 dashboard and the Tauri shell (minutes faster when the
#                                 backend didn't change)
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
shell_only=0
case "${1:-}" in
  "") ;;
  --shell) shell_only=1 ;;
  --dmg) bundles="app,dmg" ;;
  --sandbox)
    bundles="app,dmg"
    export COT_DESKTOP_SANDBOX_ID="$(date -u +%Y%m%d%H%M%S)-$$"
    icons="${DESKTOP_DIR}/build/sandbox-icons"
    "${DESKTOP_DIR}/scripts/make-sandbox-icon.sh" "${icons}"
    icon_list="\"${icons}/32x32.png\", \"${icons}/128x128.png\", \"${icons}/128x128@2x.png\", \"${icons}/icon.icns\", \"${icons}/icon.ico\""
    config="{\"version\": \"${VERSION}\", \"productName\": \"cot Sandbox\", \"identifier\": \"run.cot.sandbox.s${COT_DESKTOP_SANDBOX_ID}\", \"bundle\": {\"icon\": [${icon_list}]}}"
    ;;
  --release)
    bundles="app,dmg"
    config="{\"version\": \"${VERSION}\", \"bundle\": {\"createUpdaterArtifacts\": true}}"
    ;;
  *) echo "unknown flag: $1 (--dmg|--release|--shell|--sandbox)" >&2; exit 2 ;;
esac

if [ "${shell_only}" = 1 ]; then
  RESOURCES="${DESKTOP_DIR}/src-tauri/resources"
  [ -x "${RESOURCES}/cot-collector/cot-collector" ] || { echo "no frozen collector staged yet; run: just desktop build" >&2; exit 1; }
  printf '\n\033[1m› %s\033[0m\n' "Building dashboard (vite), reusing the frozen collector"
  "${REPO_ROOT}/scripts/ensure-node-deps.sh" "${REPO_ROOT}"
  (cd "${REPO_ROOT}" && npm run build)
  rm -rf "${RESOURCES}/static"
  cp -R "${REPO_ROOT}/dist" "${RESOURCES}/static"
else
  "${DESKTOP_DIR}/scripts/prepare-collector.sh"
fi

cd "${DESKTOP_DIR}"
"${REPO_ROOT}/scripts/ensure-node-deps.sh" "${DESKTOP_DIR}"

# An earlier DMG from this build dir that's still mounted (opened to install
# from) holds the volume name bundle_dmg.sh needs, and its layout step fails.
BUNDLE_DIR="${DESKTOP_DIR}/src-tauri/target/release/bundle"
if [ "${bundles}" = "app,dmg" ]; then
  hdiutil info | awk -v dir="${BUNDLE_DIR}/" '
    /^image-path/ { sub(/^image-path *: */, ""); mine = index($0, dir) == 1 }
    mine && /^\/dev\/disk[0-9]+s?[0-9]*\t/ && /\/Volumes\// { print $1 }
  ' | while read -r dev; do
    hdiutil detach "${dev}" -quiet || hdiutil detach "${dev}" -force -quiet || true
  done
  rm -f "${BUNDLE_DIR}"/macos/rw.*.dmg
fi
# The bundler shells out to `xattr -cr`; a pip-installed xattr earlier on PATH
# (Homebrew) doesn't take -r, so put Apple's tools first.
PATH="/usr/bin:${PATH}" npx tauri build --bundles "${bundles}" --config "${config}"

printf '\n\033[1mBuilt cot %s\033[0m\n' "${VERSION}"
ls -1 "${DESKTOP_DIR}/src-tauri/target/release/bundle/"*/ 2>/dev/null | sed 's/^/  /'

if [ "${1:-}" = "--sandbox" ]; then
  printf '\nInstall cot Sandbox.app from the DMG above. Each build has fresh onboarding state.\n'
  printf 'Data: ~/Library/Application Support/cot-sandbox/%s/home\n' "${COT_DESKTOP_SANDBOX_ID}"
fi
