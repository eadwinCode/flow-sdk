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

# bun pm pack turns workspace:* into the real version. But it does not use
# publishConfig, and it does not add the LICENSE at the repo root. So while each
# package is packed, its package.json takes the fields from publishConfig (the
# dist exports and types), and LICENSE is copied in. Both are put back after,
# even if a step fails.
backup="$(mktemp -d)"
restore() {
  local pkg="$1"
  if [ -f "$backup/$pkg.json" ]; then
    mv "$backup/$pkg.json" "$root/packages/$pkg/package.json"
    rm -f "$root/packages/$pkg/LICENSE"
  fi
}
trap 'restore protocol; restore flow; rm -rf "$backup"' EXIT

rm -f "$out"/clevix-*.tgz
for pkg in protocol flow; do
  dir="$root/packages/$pkg"
  if [ -e "$dir/LICENSE" ]; then
    echo "$dir/LICENSE should not exist: it is copied from the repo root" >&2
    exit 1
  fi
  (cd "$dir" && bun run build >/dev/null)
  cp "$dir/package.json" "$backup/$pkg.json"
  cp "$root/LICENSE" "$dir/LICENSE"
  node -e '
    const fs = require("fs");
    const file = process.argv[1];
    const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const key of ["exports", "types", "main", "module", "bin"]) {
      if (pkg.publishConfig && key in pkg.publishConfig) pkg[key] = pkg.publishConfig[key];
    }
    delete pkg.publishConfig;
    if (pkg.scripts) delete pkg.scripts.prepack; // the build above already ran
    fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
  ' "$dir/package.json"
  (cd "$dir" && bun pm pack --ignore-scripts --destination "$out" --quiet >/dev/null)
  restore "$pkg"
  test -f "$out/clevix-$pkg-$version.tgz"
done
ls -l "$out"/clevix-*.tgz
