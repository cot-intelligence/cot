#!/usr/bin/env bash
# Build cot's Linux bundles in Docker, from macOS or Linux.
#
#   scripts/build-linux.sh [build.sh flag]    default --dmg: .deb and .AppImage
#
# The bundles are for the Docker host's architecture (arm64 on Apple Silicon);
# set COT_LINUX_PLATFORM=linux/amd64 for x86_64 (slow under emulation).
# The source goes in as a copy, so the container's venv, node_modules and
# target never mix with the host's. Bundles land in desktop/build/linux/.
set -euo pipefail

DESKTOP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "${DESKTOP_DIR}/.." && pwd)"
PLATFORM="${COT_LINUX_PLATFORM:-}"
IMAGE="cot-linux-builder${PLATFORM:+-${PLATFORM##*/}}"
OUT="${DESKTOP_DIR}/build/linux"
platform_args=()
[ -n "${PLATFORM}" ] && platform_args=(--platform "${PLATFORM}")

docker build ${platform_args[@]+"${platform_args[@]}"} -t "${IMAGE}" "${DESKTOP_DIR}/packaging/linux"

rm -rf "${OUT}"
mkdir -p "${OUT}"
# Tracked and untracked-but-not-ignored files: what a commit would hold.
cd "${REPO_ROOT}"
git ls-files -z --cached --others --exclude-standard \
  | COPYFILE_DISABLE=1 tar --null -T - -cf - \
  | docker run -i --rm ${platform_args[@]+"${platform_args[@]}"} \
      -v "${IMAGE}-cargo:/usr/local/cargo/registry" \
      -v "${IMAGE}-target:/src/desktop/src-tauri/target" \
      -v "${IMAGE}-npm:/root/.npm" \
      -v "${IMAGE}-tauri:/root/.cache/tauri" \
      -v "${OUT}:/out" \
      -e TAURI_SIGNING_PRIVATE_KEY -e TAURI_SIGNING_PRIVATE_KEY_PASSWORD \
      "${IMAGE}" bash -c '
        set -euo pipefail
        mkdir -p /src && tar -xf - -C /src && cd /src
        bundle=desktop/src-tauri/target/release/bundle
        rm -rf "${bundle}"
        COT_PYTHON=python3.12 desktop/scripts/build.sh "$1"
        find "${bundle}" -maxdepth 2 -type f \( -name "*.deb" -o -name "*.AppImage" -o -name "*.sig" \) -exec cp {} /out/ \;
      ' build "${1:---dmg}"

printf '\n\033[1mLinux bundles in %s\033[0m\n' "${OUT}"
ls -1 "${OUT}" | sed 's/^/  /'
