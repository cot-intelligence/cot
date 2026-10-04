#!/usr/bin/env bash
# Build cot.app — SwiftUI shell + the frozen collector + the built dashboard.
#
#   macos/build.sh            full build into macos/build/cot.app
#   macos/build.sh --run      build, then launch it
#   macos/build.sh --app-only skip the dashboard and collector steps
#
# Nothing is installed on the host: Python deps go into macos/build/venv.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MAC_DIR="${REPO_ROOT}/macos"
BUILD_DIR="${MAC_DIR}/build"
APP="${BUILD_DIR}/cot.app"
VENV="${BUILD_DIR}/venv"
PYTHON_BIN="${COT_PYTHON:-python3}"

APP_ONLY=0
RUN_AFTER=0
for arg in "$@"; do
  case "${arg}" in
    --app-only) APP_ONLY=1 ;;
    --run) RUN_AFTER=1 ;;
    *) echo "unknown flag: ${arg}" >&2; exit 2 ;;
  esac
done

step() { printf '\n\033[1m› %s\033[0m\n' "$1"; }

VERSION="$(sed -n 's/^__version__ = "\(.*\)"$/\1/p' "${REPO_ROOT}/backend/app/__init__.py")"
[ -n "${VERSION}" ] || { echo "could not read backend/app/__init__.py version" >&2; exit 1; }

mkdir -p "${BUILD_DIR}"

# --- 1. Dashboard -------------------------------------------------------------
if [ "${APP_ONLY}" = "0" ]; then
  step "Building dashboard (vite)"
  cd "${REPO_ROOT}"
  [ -d node_modules ] || npm ci
  npm run build
fi

# --- 2. Collector -------------------------------------------------------------
if [ "${APP_ONLY}" = "0" ]; then
  step "Freezing collector (pyinstaller)"
  if [ ! -x "${VENV}/bin/python" ]; then
    "${PYTHON_BIN}" -m venv "${VENV}"
  fi
  "${VENV}/bin/pip" install --quiet --upgrade pip
  "${VENV}/bin/pip" install --quiet -r "${REPO_ROOT}/backend/requirements.txt" pyinstaller

  cd "${BUILD_DIR}"
  COT_REPO_ROOT="${REPO_ROOT}" "${VENV}/bin/pyinstaller" \
    --noconfirm --clean \
    --distpath "${BUILD_DIR}/dist" \
    --workpath "${BUILD_DIR}/work" \
    "${MAC_DIR}/packaging/cot-collector.spec"
fi

# --- 3. App icon --------------------------------------------------------------
step "Rendering app icon"
swift "${MAC_DIR}/packaging/make_icon.swift" "${BUILD_DIR}" >/dev/null
iconutil -c icns -o "${BUILD_DIR}/AppIcon.icns" "${BUILD_DIR}/AppIcon.iconset"

# --- 4. Swift shell -----------------------------------------------------------
step "Compiling SwiftUI app"
rm -rf "${APP}"
mkdir -p "${APP}/Contents/MacOS" "${APP}/Contents/Resources"

sed "s/__COT_VERSION__/${VERSION}/g" "${MAC_DIR}/Resources/Info.plist" \
  > "${APP}/Contents/Info.plist"

SDK="$(xcrun --show-sdk-path)"
swiftc \
  -swift-version 5 \
  -sdk "${SDK}" \
  -target "$(uname -m)-apple-macosx14.0" \
  -framework AppKit -framework WebKit -framework ServiceManagement \
  -O \
  -o "${APP}/Contents/MacOS/cot" \
  "${MAC_DIR}"/Sources/*.swift

# --- 5. Assemble --------------------------------------------------------------
step "Assembling bundle"
cp "${BUILD_DIR}/AppIcon.icns" "${APP}/Contents/Resources/AppIcon.icns"

if [ -d "${BUILD_DIR}/dist/cot-collector" ]; then
  cp -R "${BUILD_DIR}/dist/cot-collector" "${APP}/Contents/Resources/cot-collector"
else
  echo "warning: no frozen collector — the app will report it as missing" >&2
fi

if [ -d "${REPO_ROOT}/dist" ]; then
  cp -R "${REPO_ROOT}/dist" "${APP}/Contents/Resources/static"
else
  echo "warning: no dashboard build at dist/ — the app window will 404" >&2
fi

# Ad-hoc signature: enough for local use and for the login item to register.
# Set COT_SIGN_IDENTITY for a Developer ID build.
step "Signing"
sign_args=(--force --deep --sign "${COT_SIGN_IDENTITY:--}"
  --entitlements "${MAC_DIR}/Resources/cot.entitlements")
# Hardened runtime only matters for a Developer ID build; ad-hoc signing rejects it.
[ -n "${COT_SIGN_IDENTITY:-}" ] && sign_args+=(--options runtime --timestamp)
codesign "${sign_args[@]}" "${APP}" 2>&1 | sed 's/^/  /'

printf '\n\033[1mBuilt %s (v%s)\033[0m\n' "${APP}" "${VERSION}"

if [ "${RUN_AFTER}" = "1" ]; then
  open "${APP}"
fi
