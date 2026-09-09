#!/usr/bin/env bash
# Packs the native TypeScript Code plugin family with the pinned sibling Manifold kit.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
manifold="$(cd "$here/../.." && pwd)/manifold"
pack="$here/pack.ts"

if [ ! -f "$manifold/packages/plugin-kit/src/pack.ts" ]; then
  echo "pack.sh: the native manifold kit is missing at $manifold" >&2
  echo "pack.sh: clone atyrode/manifold beside this repo at the revision in $here/MANIFOLD_REV" >&2
  exit 1
fi

exec bun "$pack"
