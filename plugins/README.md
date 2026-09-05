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

## Commands

```sh
bun install            # zod + typescript
bun run check          # tsc over the plugins and the tests
bun test               # panel programs against a fake host, doors against a fake ctx
./pack.sh              # dist/<id>.manifold-plugin.json for every plugin + dist/SHA256SUMS
```

`pack.sh` runs the kit's `pack` over every `manifest.json` under this directory and writes
`dist/SHA256SUMS`; the sha256 printed per bundle is the pin `engine.plugins.install` demands. CI
(`.github/workflows/manifold-plugins.yml`) does the same on every push touching `plugins/` and
uploads `dist/` as an artifact. All of this repo's bundles are cut together, from one tree.
