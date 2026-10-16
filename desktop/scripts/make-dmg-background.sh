#!/usr/bin/env bash
# Render dmg/background.html to dmg/background.png at 2x, tagged 144 dpi so
# Finder shows it at 660x400 points and sharp on Retina. Needs Google Chrome
# (or Playwright's Chrome for Testing; CHROME= overrides) and network access
# for the web fonts.
set -euo pipefail

DESKTOP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ -z "${CHROME:-}" ]; then
  CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  if [ ! -x "${CHROME}" ]; then
    CHROME="$(ls -d "${HOME}"/Library/Caches/ms-playwright/chromium-*/chrome-mac*/"Google Chrome for Testing.app"/Contents/MacOS/"Google Chrome for Testing" 2>/dev/null | tail -1)"
  fi
fi
[ -x "${CHROME}" ] || { echo "no Chrome found; set CHROME=/path/to/chrome" >&2; exit 1; }
OUT="${DESKTOP_DIR}/dmg/background.png"

"${CHROME}" --headless=new --disable-gpu --hide-scrollbars \
  --force-device-scale-factor=2 --window-size=660,400 \
  --virtual-time-budget=5000 \
  --screenshot="${OUT}" "file://${DESKTOP_DIR}/dmg/background.html" >/dev/null 2>&1
sips -s dpiWidth 144 -s dpiHeight 144 "${OUT}" >/dev/null
sips -g pixelWidth -g pixelHeight -g dpiWidth "${OUT}" | tail -3
