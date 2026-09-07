# code's manifold plugins

The out-of-tree manifold plugins in this repo (migration status: `docs/manifold-transition.md`
§6). One directory per plugin, a child INSIDE its parent's directory:

| Directory                | Id                       | What                                                                                             |
| ------------------------ | ------------------------ | ------------------------------------------------------------------------------------------------ |
| `atyrode.code/`          | `atyrode.code`           | The baseline: `atyrode.code.launch` (authorize and record a launch of `code`), `atyrode.code.listLaunches`, the `launch_recorded` event. |
| `atyrode.code/generator/` | `atyrode.code.generator` | The persistent React launch panel (`launcher`): pick a machine and working directory, open interactive `code` in a terminal tile through the baseline's door. Requires `atyrode.code`. |

Every id, door name, storage key, event kind and panel id is spelled once, in
`atyrode.code/contract.ts`; both halves of every bundle import it, and `test/contract.test.ts`
pins the manifests to it.

## The SDK is a sibling checkout

The authoring tools come from `@manifold/plugin-kit` in
[atyrode/manifold](https://github.com/atyrode/manifold), pinned by `MANIFOLD_REV` to
`d8dc6c93ad6a9d467b5546aec88af3b9c42ceb87`. Until the kit is published as a release
asset, that checkout IS the SDK. `tsconfig.json` maps the public `@manifold/plugin`,
`@manifold/plugin/hooks`, `@manifold/protocol` and `@manifold/ui` imports and their
supporting packages to the sibling checkout, with React resolved from its workspace:

```
<parent>/
  code/plugins/      this directory
  manifold/          atyrode/manifold at $(cat plugins/MANIFOLD_REV), with `bun install` run
```

`bun install --frozen-lockfile` here installs zod, TypeScript and the Bun/React types;
run it in the manifold checkout too, because the kit and shared React packages
resolve from that workspace.

## In-realm authoring

The `0.2.0` bundles use Manifold's ADR 0025 in-realm model, not the historical
Worker `ui.*` vocabulary. The baseline server default-exports its definition
(`actions` and `handlers`); there is no IPC bootstrap or `defineServerPlugin`
call. Web modules default-export their registrations. The generator's `web.tsx`
registers a React component receiving `PanelProps`/`HostServices`, uses shared
`@manifold/ui` primitives, and reads machines and the authorization ledger through
`usePolledResource` and the host's client. It calls the baseline launch door, then
`host.client.openTerminal` with the authorized argv and optional machine-local cwd.

`manifest.json` declares `entry.styles: true`; `styles.css` is scoped under
`.plugin-atyrode_code_generator` (including prefixed descendant classes). The kit
carries this sheet for host admission under ADR 0025's root-class rule. Do not
replace it with global styles or bundle a separate copy of React.

`pack.sh` uses the kit's shared-module output, not `--self-contained`. Install
these bundles in normal **In-realm** mode; `--hardened` is not this React plugin's
execution contract. Packing does not grant trust. The SDK pin, host admission
and browser mounting are separate gates: a passing `verify` proves real-server
installation and door availability, not browser rendering or full Code parity.

## Commands

```sh
bun install --frozen-lockfile
bun run check          # tsc over the plugins and tests
bun test               # contract, machine selection and server-door behavior
bun run pack           # dist/<id>.manifold-plugin.json for every plugin + dist/SHA256SUMS
bun run verify         # real throwaway server: normal install, dispatch each door, uninstall
bun run dev -- --hub http://127.0.0.1:7912 --deliver docker:manifold-dev-manifold-1
                       # from dev-01: pack + install on the integrated preview, parents before
                       # parts, then watch sources and reinstall changed bundles
```

The dev command runs from this `plugins/` directory on dev-01. The kit reads the
preview container's owner credential in memory; do not put it in argv or logs.
It packs and delivers the bundles, installs parents before dependants, and watches
for changes. Changed bundles trigger the host's normal live remount; unchanged
hashes do not reinstall. Keep the authenticated preview open while editing.

`pack.sh` packs every `manifest.json` and writes `dist/SHA256SUMS`; each sha256 is
the pin `engine.plugins.install` demands. All bundles are cut together. CI
(`.github/workflows/manifold-plugins.yml`, Manifold's reusable `plugins.yml`) runs
check, test, pack and real-server verify. A `v*` release attaches the bundles and
checksums; preview delivery must use the same normal in-realm mode as the dev
loop, not the old Worker's `--hardened` flag. The receiver on the host must support
the delivery contract; changing the SDK pin does not update it. Production
(`manifold.tyrode.dev`) remains an operator install from the release URL in the
plugin manager, not a target of this dev loop.

## Try the panel on the authenticated preview

1. Open [the integrated preview](https://preview.manifold.tyrode.dev) and sign in
   normally through the production identity handoff. This does not change
   production. Workspace arrangements are per user.
2. In the plugin manager's **Installed** list, check that `atyrode.code` and
   `atyrode.code.generator` are enabled and **In-realm**. The generator declares
   a default seat between the sidebar and container view; saved custom layouts
   are preserved.
3. If **code** is absent from a custom layout, press **F8** for **Arrange** and
   choose **code** from **Shelf**. Existing pane widths can be resized there.
   Manifold [#420](https://github.com/atyrode/manifold/issues/420) tracks a
   host bug that can misplace Shelf-added panels with nested canvas portals;
   the default workspace seat uses the host's normal composed layout.
4. Open or create a composition in an editable workspace view. Pick the online
   **dev-01** machine and optionally enter a working directory that exists there
   (for example `/home/alex/code`); blank uses the machine
   default. Without a mounted editable container or an eligible machine, the
   panel explains the missing prerequisite and disables launch.
5. Press **Open code in a tile**. Expect a terminal tile in the current
   composition running interactive `code`, with the launch panel still present.
   Provider, account, model and agent selection and the dials still belong to
   that terminal. Quit the TUI with `q`: the panel remains available. Manifold
   may retire the terminal's empty composition; create another to launch again.

**Recent authorizations** is not a running-session list: the door records before
terminal creation, which can still fail, and the program can subsequently exit.
Opening a terminal does not establish that an omp coding session is ready.

Local browser/terminal proof was performed on **2026-09-07**; its exact scope and
remaining merge/operator-proof gates are recorded only in the authoritative
[§6 ledger](../docs/manifold-transition.md#6-transition-steps). This is not full
web parity. Remote catalog/dials, usage and account surfaces require the governed
common runtime for Code #97/#102, currently blocked on unpublished
[Manifold PR #375](https://github.com/atyrode/manifold/pull/375)
(#156/#235/#236). No separate `code publish` daemon or PTY-as-RPC substitute is
introduced. `atyrode.code.usage` and `atyrode.code.accounts` remain reserved until
real runtime-backed surfaces exist. Final plugin-authored launchpad placement
still depends on Manifold #134/#201; the working workspace panel plus host
composition does not close those issues. The TUI and engine configuration
ceremony remain intact until their retirement gates are met.
