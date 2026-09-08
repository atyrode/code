#!/usr/bin/env bash
# Packs every plugin directory under plugins/ into dist/<id>.manifold-plugin.json with the
# kit's `pack` from the sibling manifold checkout (pinned in MANIFOLD_REV), then writes
# dist/SHA256SUMS over the artifacts. All bundles of this repo are cut together, from one tree.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
manifold="$(cd "$here/../.." && pwd)/manifold"
pack="$manifold/packages/plugin-kit/src/pack.ts"

if [ ! -f "$pack" ]; then
  echo "pack.sh: the manifold checkout is missing at $manifold (expected the kit at $pack)" >&2
  echo "pack.sh: clone atyrode/manifold beside this repo at the rev in $here/MANIFOLD_REV" >&2
  exit 1
fi

# CODE_MACHINE_ARTIFACTS, when set, names a JSON map beside the worker archives and
# checksums.txt. The helper verifies their bytes, privately stages the family and changes
# only the staged root machine.artifacts. Unset keeps source declarations unchanged.
exec bun "$here/../scripts/machine-artifacts.ts" pack
