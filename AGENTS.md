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

## Manifold plugins

`plugins/` holds this repo's manifold plugins (`atyrode.code`, its part
`atyrode.code.generator`). Direction: `docs/manifold-transition.md`; progress:
its §6 ledger, updated in the PR that moves it; the kit: manifold's
`docs/PLUGINS.md` §9.

```
cd plugins && bun install && bun run check && bun test && bun run pack && bun run verify
                       # the gate: verify spawns a real manifold server, installs every
                       # bundle in dist/, dispatches every door, uninstalls. Green before a push.
bun run dev -- --hub http://127.0.0.1:7912 --deliver docker:manifold-dev-manifold-1
                       # from dev-01: pack + install on the integrated preview, then watch
                       # and reinstall on change. A browser reload shows the change.
```

- The SDK is a sibling checkout: `../manifold` at the rev in `plugins/MANIFOLD_REV`,
  with `bun install --frozen-lockfile` run there. Bump `MANIFOLD_REV` and the
  `uses: atyrode/manifold/.github/workflows/plugins.yml@<rev>` ref in
  `.github/workflows/manifold-plugins.yml` together, always.
- Where a change is visible: `https://preview.manifold.tyrode.dev` → plugin
  manager → Installed → `atyrode.code` (and `atyrode.code.generator`). The `code`
  panel launches only on an enrolled machine that is online on that hub; dev-01
  is enrolled there.
- Delivery, in order: PR → CI (`manifold-plugins.yml`: check, test, pack,
  verify) → `v*` tag → `release.yml` attaches `dist/*.manifold-plugin.json` +
  `SHA256SUMS` to the GitHub Release → the preview installs each bundle from
  its release URL through the receiver, parents before parts. Production
  (`https://manifold.tyrode.dev`) is the operator's: installed by hand from the
  release URL in the plugin manager, root only, never automated.
- **At the end of a plugin task, and whenever asking the operator to look, name
  the hub URL, the panel, the action and the expected result** (e.g. "on
  preview.manifold.tyrode.dev, open the `code` panel, pick dev-01, Launch: a
  terminal tile running `code` appears beside it").
- The owner key never appears in argv, logs or committed files: `dev` reads it
  from the container (`docker exec … cat /data/owner.key`) or
  `--owner-key-file`.
