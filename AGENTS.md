# Agent notes

Rules any agent (or human) must follow when working on this repository.

## A tag is a deployment

Pushing a `v*` tag triggers goreleaser and publishes release binaries.
[atyrode/dotfiles](https://github.com/atyrode/dotfiles) auto-bumps to the
latest release within ~6 hours (`scripts/update-pins.sh`) and its machines
pick it up on their next `atyrode apply`. Only tag what you would deploy.

After goreleaser finishes, run `scripts/bump-flake-pin.sh <tag>` and PR the
result: the flake wraps the published release binaries (not a source build),
so `nix run github:atyrode/code` serves the new version only once
`nix/code.nix` is repointed.

## Never move or delete a published tag

Go modules are immutable: the first time anyone — a user, CI, the dotfiles
pipeline — fetches a version, proxy.golang.org and the sum.golang.org
checksum database record its hash **forever**. Re-pointing or deleting the
tag afterwards makes every future `go install` / build of that version fail
with a permanent checksum mismatch; there is no way to un-poison it. If a
tag is bad, leave it in place and cut the next patch (`v0.1.1`).

## Iterating against cli-kit

This repo depends on [github.com/atyrode/cli-kit](https://github.com/atyrode/cli-kit).
For day-to-day work consume it by commit — `go get
github.com/atyrode/cli-kit@<sha>` (a pseudo-version) — and let cli-kit cut
real tags only at milestones. The same tag-immutability rule applies there.

## Cross-repo invariants

- atyrode/dotfiles wraps this binary (omp-configured's `codeLauncher`) and
  owns personalization (catalog, usage broker, vaults). Keep the `CODE_*`
  environment variables backward-compatible; the wrapper relies on them.
- The `ctrl+o` default model must stay in sync with cli-kit's
  `ollama.DefaultModel` and the dotfiles' `localClassifier.model`
  (`qwen2.5:3b` today).
- Supported provider assumption: omp with **both Anthropic and OpenAI**
  available (see README). Features may degrade with fewer providers but must
  not crash.
