# Code's Manifold plugin

Code is a **Manifold-native plugin first**, controlled through Manifold's web GUI.
The current standalone Code CLI/TUI is **deprecated**, not a second product to
keep alongside Manifold. Architectural ownership and implementation status live
in [the transition record, section 6](../docs/manifold-transition.md#6-transition-steps),
the sole transition ledger for [#149](https://github.com/atyrode/code/issues/149).

## Authoring requirements

- Provision Code through Manifold's plugin and declarative resource mechanisms.
  Users must not need a standalone Code installation, wrapper, separate setup,
  or a permanent CLI recovery path. A future CLI would be designed as a Manifold
  client, not retained for compatibility with the deprecated launcher.
- Manifold owns fleet, permissions, multiplayer/shared state, persistence,
  resource lifecycle, execution, scheduling, and traces. Code supplies its domain
  behavior and web controls; it must not recreate these generic facilities.
  A missing generic capability belongs in Manifold before Code consumes it.
- Keep **one Manifold-owned source of Code state**, including configuration and
  preferences. Do not synchronize independent CLI and GUI preference stores or
  make `CODE_*` variables an alternate authority. If useful existing data is
  adopted, that is an explicit native operation, not mandatory legacy setup or
  a second permanent store.
- Describe required resources declaratively and let Manifold govern their
  provisioning and lifecycle. Use native scoped service access and current
  native permissions and audit for operations; neither a Code-specific policy
  layer nor direct service credentials may bypass that authority. Legacy or
  external services can become governed native resources without preserving
  standalone Code architecture.
- Use private worker executables only where execution requires them. They are
  implementation details provisioned and operated by Manifold, not a separately
  installed or configured Code product. OMP's terminal is an execution surface,
  not the control plane or source of Code state. No CLI/TUI parity requirement
  constrains the web rework.
- Promote exact, reviewed revisions explicitly. Identify the Code revision,
  pinned Manifold revision, and bundle hashes; do not silently follow a moving
  checkout or replace published release bytes. Local build evidence is not live
  acceptance or permission to install a revision on a shared environment.

These are implementation requirements, **not claims about APIs already present
on main**. Native resource, service-access, execution, permission, and audit
integration must use the actual Manifold contract as it is implemented. Missing
primitives must be added there rather than hidden behind Code-local substitutes.

## What the checkout currently contains

Main at `288190f` still contains the deprecated CLI/TUI and these bootstrap
plugins. A child plugin directory is nested inside its parent's directory:

| Directory | Id | Current bootstrap behavior — not the target setup |
| --- | --- | --- |
| `atyrode.code/` | `atyrode.code` | `atyrode.code.launch` authorizes and records a launch of the legacy `code` program; `atyrode.code.listLaunches` reads that ledger; `launch_recorded` reports the recording. |
| `atyrode.code/generator/` | `atyrode.code.generator` | The `launcher` panel selects a machine and opens legacy `code` in a terminal tile after calling the baseline. Requires `atyrode.code`. |

Ids, door names, storage keys, event kinds, and panel ids are shared through
`atyrode.code/contract.ts`; bundles import it and `test/contract.test.ts` checks
the manifests against it. The existing launch action declares `terminals:spawn`,
checks machine availability, and records the current principal in host storage.
The panel opens the terminal separately. That bootstrap launch record is not
proof of native resource provisioning, execution completion, or the target audit
and lifecycle integration.

[Draft PR #148](https://github.com/atyrode/code/pull/148)
(`feat/manifold-runtime-controls`) contains candidate headless, React, and
native-job work, not APIs available on main. Its standalone coexistence
assumptions were rejected and need rework. Neither those candidates nor the
bootstrap bundles establish a completed or preview-ready native Code plugin.
Implementation progress and future live acceptance belong only in the
[transition ledger](../docs/manifold-transition.md#6-transition-steps).

## The SDK is a sibling checkout

The current bootstrap plugins use `@manifold/plugin-kit` and
`@manifold/protocol` from [atyrode/manifold](https://github.com/atyrode/manifold)
at the exact revision recorded in `MANIFOLD_REV`. The sibling checkout is the SDK
used by the current development tooling; `tsconfig.json` maps those packages to
`../../manifold/packages/{plugin-kit,protocol}/src`:

```text
<parent>/
  code/plugins/      this directory
  manifold/          atyrode/manifold at the revision in code/plugins/MANIFOLD_REV
```

Run `bun install --frozen-lockfile` in the Manifold checkout once to install its
workspace dependencies. In `code/plugins`, the local package installs `zod`
(pinned to the kit's version), TypeScript, and Bun types. This is a developer SDK
layout, not an instruction to install standalone Code on target machines.
The reusable workflow reference in `.github/workflows/manifold-plugins.yml` and
`MANIFOLD_REV` must move together when changing the SDK pin. The pinned kit's
commands are described in Manifold's `docs/PLUGINS.md` section 9; a pin is not
evidence that it already supplies all primitives required by the native target.

## Available development commands

From `code/plugins`, the current scripts are:

```sh
bun install --frozen-lockfile
bun run check          # TypeScript over the bootstrap plugins and tests
bun test               # panel programs against a fake host; doors against a fake context
bun run pack           # dist/<id>.manifold-plugin.json and dist/SHA256SUMS
bun run verify         # kit verifier: spawned server, bundle install, door dispatch, uninstall
```

These checks exercise the bundles that exist in the checkout. Passing them does
not prove the target web workflow, native resource lifecycle, or live acceptance.

`bun run dev -- --hub <development-hub-url> --deliver <delivery-target>` is also
available through the pinned kit. It packs, installs, watches, and reinstalls
bundles; it is **mutating**, not a read-only check. Use it only with an explicitly
authorized development target. No installed preview is promised by this guide.

## Bundle identity and existing release wiring

`pack.sh` runs the pinned kit's packer over each plugin's `manifest.json`, writes
`dist/<id>.manifold-plugin.json`, and records the bundle SHA-256 values in
`dist/SHA256SUMS`. `engine.plugins.install` requires the bundle's hash pin.
All bundles are built together from one tree. Preserve immutable release
identity: released URLs and hashes must identify the reviewed bytes, and a
changed bundle needs a new release rather than replacement of an existing asset.

The existing `.github/workflows/manifold-plugins.yml` invokes Manifold's pinned
reusable workflow for checks, tests, packing, and verification on relevant main
pushes and pull requests. The existing `v*` release workflow builds legacy
binaries, attaches plugin bundles and checksums, and has a preview receiver step
that runs only when `DEV_DEPLOY_HOST` is configured. Its upload command currently
allows clobbering assets; that mechanism is not permission to overwrite an
immutable release. These are legacy workflow facts, not the native product's
release design or evidence that any preview has received a bundle. The existing
production path is an operator installation from a release URL in Manifold's
plugin manager, not an automatic production deployment.

Target promotion must be explicit for exact revisions under the transition
record's acceptance process. This documentation change authorizes no release,
live deployment, credential relocation, broker retirement, or destructive state
change. Do not run a tag release or remote development install to establish the
native target's status.
