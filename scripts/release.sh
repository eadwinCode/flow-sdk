#!/usr/bin/env bash
# Builds the release files for one version.
#
#   scripts/release.sh 0.2.0 /tmp/release
#
# Checks that every version number matches, then writes
# /tmp/release/clevix-flow-0.2.0.tgz and /tmp/release/clevix-protocol-0.2.0.tgz.
# It uploads nothing; .github/workflows/release.yml does that. See RELEASING.md.
set -euo pipefail

version="${1:?usage: scripts/release.sh <version> <out dir>}"
mkdir -p "${2:?usage: scripts/release.sh <version> <out dir>}"
out="$(cd "$2" && pwd)"
root="$(cd "$(dirname "$0")/.." && pwd)"

check() {
  if [ "$2" != "$version" ]; then
    echo "$1 says $2, but the release is $version" >&2
    exit 1
  fi
}
check packages/flow/package.json "$(node -p "require('$root/packages/flow/package.json').version")"
check packages/protocol/package.json "$(node -p "require('$root/packages/protocol/package.json').version")"
check packages/flow/src/version.ts "$(sed -n 's/.*SDK_VERSION = "\(.*\)".*/\1/p' "$root/packages/flow/src/version.ts")"
check flow.go "$(sed -n 's/^const Version = "\(.*\)"/\1/p' "$root/flow.go")"

rm -f "$out"/clevix-*.tgz
for pkg in protocol flow; do
  (cd "$root/packages/$pkg" && pnpm pack --pack-destination "$out" >/dev/null)
  test -f "$out/clevix-$pkg-$version.tgz"
done
ls -l "$out"/clevix-*.tgz
