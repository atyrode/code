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

cd "$here"
rm -rf dist
mkdir -p dist

# A plugin directory is one holding manifest.json; a child lives INSIDE its parent's directory.
while IFS= read -r manifest; do
  dir="$(dirname "$manifest")"
  id="$(bun -e 'console.log(JSON.parse(await Bun.file(process.argv[1]).text()).id)' "$manifest")"
  bun "$pack" "$dir" --out "dist/$id.manifold-plugin.json"
done < <(find . -path ./node_modules -prune -o -path ./dist -prune -o -name manifest.json -print | sort)

(cd dist && sha256sum -- *.manifold-plugin.json > SHA256SUMS)
cat dist/SHA256SUMS
