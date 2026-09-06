# code's manifold plugins

The out-of-tree manifold plugins this repo ships (transition record: `docs/manifold-transition.md`,
"Topology and first plugin"). One directory per plugin, a child INSIDE its parent's directory:

| Directory                | Id                       | What                                                                                             |
| ------------------------ | ------------------------ | ------------------------------------------------------------------------------------------------ |
| `atyrode.code/`          | `atyrode.code`           | The baseline: `atyrode.code.launch` (authorize and record a launch of `code`), `atyrode.code.listLaunches`, the `launch_recorded` event. |
| `atyrode.code/generator/` | `atyrode.code.generator` | The launch panel (`launcher`): pick a machine, open `code` in a terminal tile through the baseline's door. Requires `atyrode.code`. |

Every id, door name, storage key, event kind and panel id is spelled once, in
`atyrode.code/contract.ts`; both halves of every bundle import it, and `test/contract.test.ts`
pins the manifests to it.

## The SDK is a sibling checkout

The plugins are written against `@manifold/plugin-kit` and `@manifold/protocol` from
[atyrode/manifold](https://github.com/atyrode/manifold) at the revision in `MANIFOLD_REV`. Until
the kit is published as a release asset, that checkout IS the SDK: `tsconfig.json` maps the two
packages to `../../manifold/packages/{plugin-kit,protocol}/src`, so the layout is

```
<parent>/
  code/plugins/      this directory
  manifold/          atyrode/manifold at $(cat plugins/MANIFOLD_REV), with `bun install` run
```

`bun install` here fetches only `zod` (the kit's own dependency, pinned to the kit's version) and
`typescript`; the manifold checkout needs its own `bun install --frozen-lockfile` once, because the
kit resolves the protocol and zod from its workspace.

The pinned SDK supports two install modes. The baseline server default-exports its
`ServerPluginDef` for normal module loading and calls `defineServerPlugin` to bind IPC
when loaded as a hardened child. The latter call is inert on a normal import; it does
not supply the default export. The generator remains web-only and uses the baseline's
doors. Packing never selects trust: the installer chooses hardened isolation with
Manifold's existing consent rules. The local verification gate exercises both modes
on disposable hubs, not the integrated preview.

## Commands

```sh
bun install            # zod + typescript
bun run check          # tsc over the plugins and the tests
bun test               # panel programs, doors and an imported packed server definition
bun run pack           # dist/<id>.manifold-plugin.json for every plugin + dist/SHA256SUMS
bun run verify         # real throwaway hubs: install both bundles normally, then hardened;
                       # dispatch every door and uninstall in each mode
bun run dev -- --hub http://127.0.0.1:7912 --deliver docker:manifold-dev-manifold-1
                       # from dev-01: pack + install on the integrated preview, parents before
                       # parts, then watch this directory and reinstall whatever changed
```

`pack.sh` runs the kit's `pack` over every `manifest.json` under this directory and writes
`dist/SHA256SUMS`; the sha256 printed per bundle is the pin `engine.plugins.install` demands. All
of this repo's bundles are cut together, from one tree, and travel one path: CI
(`.github/workflows/manifold-plugins.yml`, manifold's reusable `plugins.yml`) runs check, test,
pack and verify on every push touching `plugins/`; a `v*` tag (`release.yml`) attaches
`dist/*.manifold-plugin.json` and `SHA256SUMS` to the GitHub Release and hands each bundle's URL
and sha to the integrated preview's receiver, which installs it on
`preview.manifold.tyrode.dev`. Production (`manifold.tyrode.dev`) is installed by the operator,
by hand, from the release URL in the plugin manager. The kit's commands are documented in
manifold's `docs/PLUGINS.md` §9.
