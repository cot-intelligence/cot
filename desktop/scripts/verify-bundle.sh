#!/usr/bin/env bash
# Check a built cot.app (or Linux .deb / .AppImage) before it ships: the
# collector and dashboard are inside, and the bundled collector starts and
# answers /health.
#
#   scripts/verify-bundle.sh [path/to/cot.app | cot.deb | cot.AppImage]
#
# The collector runs against a temp HOME and database on a free port, so this
# never touches ~/.cot or a collector already running on 31337.
set -euo pipefail

DESKTOP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUNDLE_DIR="${DESKTOP_DIR}/src-tauri/target/release/bundle"

fail() { printf 'verify-bundle: %s\n' "$1" >&2; exit 1; }

unpacked=""
if [ "$(uname -s)" = Linux ]; then
  APP="${1:-$(ls "${BUNDLE_DIR}"/deb/*.deb 2>/dev/null | head -1)}"
  [ -f "${APP}" ] || fail "no .deb or .AppImage at ${APP:-${BUNDLE_DIR}/deb}"
  unpacked="$(mktemp -d)"
  case "${APP}" in
    *.deb) dpkg-deb -x "${APP}" "${unpacked}" ;;
    *.AppImage) (cd "${unpacked}" && "$(cd "$(dirname "${APP}")" && pwd)/$(basename "${APP}")" --appimage-extract >/dev/null) ;;
    *) fail "not a .deb or .AppImage: ${APP}" ;;
  esac
  # Tauri puts resources in usr/lib/<productName>/.
  COLLECTOR="$(find "${unpacked}" -path '*/usr/lib/*/cot-collector/cot-collector' -type f | head -1)"
  [ -n "${COLLECTOR}" ] || fail "missing usr/lib/*/cot-collector/cot-collector in ${APP}"
  RES="$(dirname "$(dirname "${COLLECTOR}")")"
else
  APP="${1:-${BUNDLE_DIR}/macos/cot.app}"
  RES="${APP}/Contents/Resources"
  COLLECTOR="${RES}/cot-collector/cot-collector"
  [ -d "${APP}" ] || fail "no app at ${APP}"
fi

[ -x "${COLLECTOR}" ] || fail "missing ${COLLECTOR}"
[ -f "${RES}/static/index.html" ] || fail "missing ${RES}/static/index.html"
if [ -z "${unpacked}" ]; then
  codesign --verify --strict "${APP}" || fail "code signature does not verify"
fi

scratch="$(mktemp -d)"
port="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')"
HOME="${scratch}" COT_HOST=127.0.0.1 COT_PORT="${port}" COT_DB_PATH="${scratch}/cot.db" \
  COT_STATIC_DIR="${RES}/static" COT_DISABLE_UPDATE_CHECK=1 \
  "${COLLECTOR}" >"${scratch}/collector.log" 2>&1 &
pid=$!
cleanup() { kill "${pid}" 2>/dev/null || true; wait "${pid}" 2>/dev/null || true; rm -rf "${scratch}" ${unpacked:+"${unpacked}"}; }
trap cleanup EXIT

for _ in $(seq 1 60); do
  if health="$(curl -fsS -m 1 "http://127.0.0.1:${port}/health" 2>/dev/null)"; then
    printf '%s' "${health}" | grep -q '"status":"ok"' || fail "unhealthy: ${health}"
    curl -fsS -m 2 "http://127.0.0.1:${port}/" | grep -qi '<html' || fail "collector does not serve the dashboard"
    printf 'verify-bundle: ok (%s)\n' "${health}"
    exit 0
  fi
  kill -0 "${pid}" 2>/dev/null || { cat "${scratch}/collector.log" >&2; fail "collector exited on startup"; }
  sleep 0.5
done
cat "${scratch}/collector.log" >&2
fail "collector did not answer /health within 30s"
