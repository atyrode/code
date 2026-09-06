#!/usr/bin/env bash
# The gate CI runs (.github/workflows/ci.yml), as one command: gofmt drift,
# vet, then the test suite. Nothing here is missing from CI and nothing in CI
# is missing here except the containment backend CI provisions for itself: on
# a machine without bubblewrap and a user systemd session the sandbox
# scenarios skip with an UNVERIFIED line on stderr instead of failing, and
# CODE_REQUIRE_SANDBOX=1 restores CI's behaviour (sandbox_linux_test.go).
#
# Extra arguments go to `go test`, so `scripts/gate.sh -run TestX` is the
# quick loop and a bare run is the whole gate.
#
# go is taken from PATH when present and from nixpkgs otherwise. CGO is off
# because the release binaries are built that way (.goreleaser.yaml), and a
# machine without a C compiler would otherwise fail in runtime/cgo before
# reaching a single test.
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
export CGO_ENABLED=0

if command -v go >/dev/null 2>&1; then
  run() { "$@"; }
else
  run() { nix shell nixpkgs#go -c "$@"; }
fi

drift="$(run gofmt -l .)"
if [ -n "$drift" ]; then
  echo "gofmt needed on:"
  echo "$drift"
  exit 1
fi
run go vet ./...
run go test ./... "$@"
