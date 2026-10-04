#!/usr/bin/env bash
# Prepare a release locally: bump the version, test, commit, tag. Never pushes.
#
#   scripts/release.sh 1.11.0 "One-line summary for the tag"
#   SKIP_TESTS=1 scripts/release.sh 1.11.0 "…"     skip `just test`
#
# Pushing the tag is the release: docker-publish builds ghcr.io/…/cot:v<version>
# (and :latest), and desktop-release builds, signs and publishes the DMG and
# opens the site PR that ships the update to installed apps. So this stops
# before any push and prints the commands instead.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"
VERSION="${1:-}"
SUMMARY="${2:-}"
INIT="backend/app/__init__.py"

die() { printf 'release: %s\n' "$1" >&2; exit 1; }
step() { printf '\n\033[1m› %s\033[0m\n' "$1"; }

[[ "${VERSION}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "usage: just release <x.y.z> \"summary\""
[ -n "${SUMMARY}" ] || die "give a one-line summary for the tag"
[ "$(git branch --show-current)" = main ] || die "releases are cut from main (on $(git branch --show-current))"
git diff --quiet && git diff --cached --quiet || die "working tree has uncommitted changes"
git rev-parse -q --verify "refs/tags/v${VERSION}" >/dev/null && die "tag v${VERSION} already exists"

CURRENT="$(sed -n 's/^__version__ = "\(.*\)"$/\1/p' "${INIT}")"
# Numeric compare, as the update check does (1.10.0 > 1.9.1).
newer=$(python3 -c "import sys; a,b=(tuple(map(int,v.split('.'))) for v in sys.argv[1:]); print(int(a>b))" "${VERSION}" "${CURRENT}")
[ "${newer}" = 1 ] || die "${VERSION} is not newer than the current ${CURRENT}"

step "Version ${CURRENT} → ${VERSION}"
sed -i '' "s/^__version__ = \".*\"$/__version__ = \"${VERSION}\"/" "${INIT}"
grep -q "__version__ = \"${VERSION}\"" "${INIT}" || die "could not update ${INIT}"

if [ "${SKIP_TESTS:-0}" != 1 ]; then
  step "Tests"
  just test || { git checkout -- "${INIT}"; die "tests failed; version bump reverted"; }
fi

step "Commit and tag"
git add "${INIT}"
git commit -q -m "chore: prepare v${VERSION} release"
git tag -a "v${VERSION}" -m "v${VERSION}: ${SUMMARY}"
git log --oneline -1
printf 'tagged v%s (not pushed)\n' "${VERSION}"

cat <<EOF

To publish, push main and then the tag (over SSH):
  git push origin main
  git push origin v${VERSION}
That runs docker-publish (image v${VERSION} + latest) and desktop-release (DMG + site PR).
Then update cot.run: public/version.json, public/install fallback, src/content.ts badge.

To undo before pushing:
  git tag -d v${VERSION} && git reset --hard HEAD~1
EOF
