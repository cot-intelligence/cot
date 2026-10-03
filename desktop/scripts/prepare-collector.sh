#!/usr/bin/env bash
# Freeze the collector and build the dashboard into src-tauri/resources/, where
# tauri.conf.json bundles them as Contents/Resources/{cot-collector,static}.
#
#   scripts/prepare-collector.sh              always rebuild
#   scripts/prepare-collector.sh --if-missing skip when resources exist (tauri dev)
#
# Reuses the Swift app's PyInstaller spec and entrypoint in macos/packaging, so
# both apps ship the same collector. Python deps go into desktop/build/venv.
set -euo pipefail

DESKTOP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "${DESKTOP_DIR}/.." && pwd)"
BUILD_DIR="${DESKTOP_DIR}/build"
VENV="${BUILD_DIR}/venv"
RESOURCES="${DESKTOP_DIR}/src-tauri/resources"
PYTHON_BIN="${COT_PYTHON:-python3.12}"
command -v "${PYTHON_BIN}" >/dev/null || PYTHON_BIN=python3

if [ "${1:-}" = "--if-missing" ] \
  && [ -x "${RESOURCES}/cot-collector/cot-collector" ] \
  && [ -f "${RESOURCES}/static/index.html" ]; then
  exit 0
fi

step() { printf '\n\033[1m› %s\033[0m\n' "$1"; }

step "Building dashboard (vite)"
cd "${REPO_ROOT}"
[ -d node_modules ] || npm ci
npm run build

step "Freezing collector (pyinstaller)"
mkdir -p "${BUILD_DIR}"
[ -x "${VENV}/bin/python" ] || "${PYTHON_BIN}" -m venv "${VENV}"
"${VENV}/bin/pip" install --quiet --upgrade pip
"${VENV}/bin/pip" install --quiet -r "${REPO_ROOT}/backend/requirements.txt" pyinstaller
cd "${BUILD_DIR}"
COT_REPO_ROOT="${REPO_ROOT}" "${VENV}/bin/pyinstaller" \
  --noconfirm --clean --log-level WARN \
  --distpath "${BUILD_DIR}/dist" \
  --workpath "${BUILD_DIR}/work" \
  "${REPO_ROOT}/macos/packaging/cot-collector.spec"

step "Staging resources"
rm -rf "${RESOURCES}"
mkdir -p "${RESOURCES}"
cp -R "${BUILD_DIR}/dist/cot-collector" "${RESOURCES}/cot-collector"
cp -R "${REPO_ROOT}/dist" "${RESOURCES}/static"
printf 'staged %s\n' "${RESOURCES}"
