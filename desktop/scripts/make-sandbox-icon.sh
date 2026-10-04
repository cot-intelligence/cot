#!/usr/bin/env bash
# Derive the test icon for `just desktop fresh` from src-tauri/icons/icon.svg:
# amber tile, white dot and a TEST band, so the sandbox app never passes for cot.app.
#   scripts/make-sandbox-icon.sh <out-dir>
set -euo pipefail

DESKTOP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${1:?usage: make-sandbox-icon.sh <out-dir>}"
mkdir -p "${OUT}"
SVG="${OUT}/icon.svg"

band='<clipPath id="tile"><rect x="100" y="100" width="824" height="824" rx="185"/></clipPath>'
band+='<g clip-path="url(#tile)"><rect x="100" y="742" width="824" height="182" fill="#1C1917"/>'
band+='<text x="512" y="868" text-anchor="middle" font-family="Helvetica Neue, Helvetica, Arial, sans-serif" font-weight="700" font-size="112" letter-spacing="28" fill="#FFFFFF">TEST</text></g>'

sed -e 's/fill="#0F5B3E"/fill="#B45309"/' \
    -e 's/fill="#C8F169"/fill="#FFFFFF"/' \
    -e "s|</svg>|${band}</svg>|" \
    "${DESKTOP_DIR}/src-tauri/icons/icon.svg" > "${SVG}"

"${DESKTOP_DIR}/scripts/make-app-icon.sh" "${SVG}" "${OUT}" >/dev/null
