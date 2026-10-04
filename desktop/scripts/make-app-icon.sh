#!/usr/bin/env bash
# Render src-tauri/icons/icon.svg into every app icon Tauri bundles: the PNGs,
# icon.icns (macOS) and icon.ico (Windows). Needs rsvg-convert and ImageMagick
# (brew install librsvg imagemagick). Edit the SVG with make-app-icon-svg.py.
set -euo pipefail

ICONS="$(cd "$(dirname "${BASH_SOURCE[0]}")/../src-tauri/icons" && pwd)"
SVG="${ICONS}/icon.svg"
TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT

render() { rsvg-convert -w "$1" -h "$1" "${SVG}" -o "$2"; }

render 32 "${ICONS}/32x32.png"
render 64 "${ICONS}/64x64.png"
render 128 "${ICONS}/128x128.png"
render 256 "${ICONS}/128x128@2x.png"
render 512 "${ICONS}/icon.png"

SET="${TMP}/icon.iconset"
mkdir "${SET}"
for size in 16 32 128 256 512; do
  render "${size}" "${SET}/icon_${size}x${size}.png"
  render "$((size * 2))" "${SET}/icon_${size}x${size}@2x.png"
done
iconutil -c icns "${SET}" -o "${ICONS}/icon.icns"

for size in 16 24 32 48 64 256; do render "${size}" "${TMP}/ico-${size}.png"; done
magick "${TMP}"/ico-{16,24,32,48,64,256}.png "${ICONS}/icon.ico"

ls -la "${ICONS}"/*.png "${ICONS}"/icon.icns "${ICONS}"/icon.ico
