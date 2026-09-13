#!/usr/bin/env bash
# The local and CI gate for the native Code plugin family.
# Check out Manifold beside Code at plugins/MANIFOLD_REV before running.
set -euo pipefail

here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
manifold="$(dirname -- "$here")/manifold"

if [ "$#" -ne 0 ]; then
  echo "usage: scripts/gate.sh (runs the complete native plugin gate)" >&2
  exit 1
fi
if ! command -v bun >/dev/null 2>&1; then
  echo "gate.sh: Bun 1.4.2 is required" >&2
  exit 1
fi
version="$(bun --version)"
if [ "$version" != "1.4.2" ]; then
  echo "gate.sh: Bun 1.4.2 is required; found $version" >&2
  exit 1
fi
if [ ! -f "$manifold/packages/plugin-kit/src/pack.ts" ]; then
  echo "gate.sh: the native Manifold kit is unavailable at $manifold" >&2
  echo "gate.sh: check out atyrode/manifold beside Code at plugins/MANIFOLD_REV" >&2
  exit 1
fi
revision="$(tr -d '[:space:]' < "$here/plugins/MANIFOLD_REV")"
if [ -z "$revision" ] || [ "$(git -C "$manifold" rev-parse HEAD)" != "$revision" ]; then
  echo "gate.sh: the sibling Manifold checkout must be at plugins/MANIFOLD_REV" >&2
  exit 1
fi

(cd -- "$manifold" && bun install --frozen-lockfile)
cd -- "$here/plugins"
bun install --frozen-lockfile
bun run prepare:integration
bun run check
bun run test
bun run pack
bun run verify
