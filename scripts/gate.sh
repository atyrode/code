#!/usr/bin/env bash
# The gate CI runs (.github/workflows/ci.yml), as one command: gofmt drift,
# vet, then the test suite. CI provisions both the containment backend and the
# bundled OMP pin. Locally, unavailable bubblewrap/user systemd or omp skips
# their scenarios with an UNVERIFIED line; CODE_REQUIRE_SANDBOX=1 and
# CODE_TEST_REQUIRE_OMP=1 restore CI's required measurements. Build .#omp and
# put its bin directory on PATH to measure the same runtime as CI.
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
if [ -n "${CI:-}" ]; then
  export CODE_TEST_REQUIRE_OMP=1
fi

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
