#!/usr/bin/env bash
# Repoint the flake's self-pin (nix/code.nix) at a published release, so
# `nix run github:atyrode/code` serves it. Run after goreleaser finishes:
#
#   scripts/bump-flake-pin.sh v0.2.0
#
# Requires curl and nix. Commit the result via a PR (main is protected).
set -euo pipefail

tag="${1:?usage: bump-flake-pin.sh vX.Y.Z}"
version="${tag#v}"
file="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)/nix/code.nix"

to_sri() {
  nix hash convert --hash-algo sha256 --to sri "$1" 2>/dev/null ||
    nix hash to-sri --type sha256 "$1"
}

sums="$(curl -fsSL "https://github.com/atyrode/code/releases/download/$tag/checksums.txt")"
sed -i "s/version = \"[0-9.]*\"/version = \"$version\"/" "$file"
while read -r hex name; do
  [[ "$name" == *.tar.gz ]] || continue
  asset="${name%.tar.gz}"
  sri="$(to_sri "$hex")"
  awk -v asset="$asset" -v hash="$sri" '
    index($0, "\"" asset "\"") { pending = 1 }
    pending && $1 == "hash" { sub(/sha256-[A-Za-z0-9+\/=]+/, hash); pending = 0 }
    { print }
  ' "$file" > "$file.bump" && mv "$file.bump" "$file"
done <<< "$sums"

echo "pinned nix/code.nix to $tag"
