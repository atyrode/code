# Code's Manifold plugins

Code supplies product semantics; Manifold owns machines, execution, consent,
job history, shared storage, terminal creation and workspace placement. Current
migration evidence lives only in [the transition ledger](../docs/manifold-transition.md#6-transition-steps).

| Directory | Plugin | Surface |
| --- | --- | --- |
| `atyrode.code/` | `atyrode.code` | `run`, `observe`, `applyAccountChoices` and `prepareLaunch` doors over native services. |
| `atyrode.code/generator/` | `atyrode.code.generator` | The `launcher` panel: real catalog dials, routing, suggestions and reviewed headless launches; explicit CLI recovery. |
| `atyrode.code/usage/` | `atyrode.code.usage` | Independent usage observations, freshness and explicit refresh requests. |
| `atyrode.code/accounts/` | `atyrode.code.accounts` | Independent account choices, named presets, reviewed import and block clearing. |

The generator requests a default workspace seat. Usage and Accounts are
available through native **F8 → Arrange → Shelf**, rather than forcing three
narrow columns into every workspace. Existing saved arrangements are preserved.
All parts require the parent; disablement, installation and placement remain
native Manifold operations.

## SDK and authoring

`MANIFOLD_REV` pins the sibling [atyrode/manifold](https://github.com/atyrode/manifold)
checkout to `f5fd6bdbc5fe8499badba58f31919d1a46598483`, including governed job
discovery and atomic plugin-storage compare-and-set. Update that file and the
reusable workflow reference in `.github/workflows/manifold-plugins.yml` together.

```text
<parent>/
  code/plugins/
  manifold/       pinned SDK, with bun install --frozen-lockfile run
```

Run `bun install --frozen-lockfile` in both checkouts. Code's TypeScript paths
resolve the public plugin, protocol and UI packages there; React is shared from
the SDK workspace. No private host imports, vendored SDK or second React runtime
are needed.

The `0.3.0` bundles use normal **In-realm** React modules and default-export server
handlers. Components receive `PanelProps`/`HostServices`, use `@manifold/ui`, and
observe native machine/job events with the shared resource hook. Each part's CSS
is rooted under its own `plugin-atyrode_code…` class. Do not install these React
bundles with the historical `--hardened` mode or replace native events with a
Code publisher daemon.

## Governed machine operations

The parent declares a closed `code-machine` worker for inspection, usage,
account listing/import, account toggles, preset create/update/activate/delete,
block clearing and suggestions. The worker executes the reviewed
`/runtime/bin/code` tool, validates bounded JSON, and projects public output.
Raw stderr, internal credential ids, credentials, paths and session metadata are
not published as job observations. Public account identities remain personal
data and are read only through current native job/output authority.

The source manifest deliberately has an empty `machine.artifacts` map. It is
**unavailable**, not a fake executable or a claim that a machine is ready.
The release build produces static Linux x64/arm64 workers. `scripts/machine-artifacts.ts`
verifies the actual archives and release checksums, derives entry/archive hashes
and bounds, then `pack.sh` stages that map when `CODE_MACHINE_ARTIFACTS` is set.
The checked-in declaration is not overwritten. Missing archives, bad checksums,
wrong architecture, dynamic executables and unsafe archive entries are refused.
A source pack without that variable stays explicitly unavailable.

A real installation also needs Manifold's proved owner and reviewed `code`/`omp`
runtime-tool bindings. The Code wrapper must support the headless verbs and
reference the intended catalog and dependencies. Broker reads additionally need
explicit machine-local credential-resource and host-network consent. Do not
copy a token into the hub, treat a mutable secret as an immutable tool dependency,
grant a whole home/state directory, bypass the wrapper, or use a terminal as RPC.
These are native machine-configuration prerequisites, not privileges this plugin
can create for itself. Production and fleet activation are separate operator work.

The shared reviewed job/terminal profile and safe resource bindings are tracked
in [Manifold #447](https://github.com/atyrode/manifold/issues/447), refining
[its executable lifecycle work](https://github.com/atyrode/manifold/issues/153).
A worker release alone does not satisfy that prerequisite.

## Shared choices and launch review

Account jobs evaluate Code's existing Go semantics. They do not write the CLI
selection file: the worker passes a portable `--state` document and returns a
proposal tied to its starting revision. Applying it uses native storage
compare-and-set. Two participants cannot silently overwrite one another; a stale
proposal must be reviewed again. A locally confirmed change continues to apply
only after its exact job succeeds; proposals recovered after a reload need
explicit review. The event invalidates reads without broadcasting identities.

The first saved change adopts the reviewed public choices. **Review import from
machine** is a separate declared operation: it reads the machine's existing
choices, shows the complete replacement, and applies only after confirmation and
CAS. It can replace an old inaccessible revision without disclosing it. Neither
path moves credentials or rewrites the original state file. Ordinary CLI/TUI
settings and explicit `CODE_*` overrides remain intact.

Shared-choice inspection and launch require an adopted revision, not an
unversioned reading of CLI defaults. Launch preparation checks the exact machine,
inspection job, facet selection and account revision, then returns an ephemeral
`code launch --account-selection=…` program for native terminal creation. Go
validates the selected identities again against the fresh broker. **Existing CLI
settings** is an explicit separate choice. The terminal's wrapper/catalog must
match the reviewed machine profile; no cross-surface profile binding is invented
inside Code.

There is no duplicate Code launch ledger. Manifold owns actual terminals and
job history; opening a terminal is not proof that omp became ready. Old ledger
rows are not migrated or silently deleted. Native storage data versioning and
explicit purge cover the parent's public preferences.

Usage is a timestamped observation, not a quota guarantee. Native schedules own
automatic refresh; they pin their input payload. A schedule using shared choices
must be updated when that revision changes, otherwise the panel labels its result
stale. Portable usage never borrows the standalone usage cache. First-run
inspection reports a missing catalog and provider availability without writing
configuration; `code generate init` and `code generate` remain the headless
recovery path. OAuth login remains in Code's existing local terminal flow.

## Commands and proof boundaries

```sh
bun install --frozen-lockfile
bun run check
bun test
bun run pack
bun run verify
bun run dev -- --hub http://127.0.0.1:7912 --deliver docker:manifold-dev-manifold-1
```

Run the dev command from this directory on dev-01. The kit keeps the preview
owner credential in memory, installs parents before parts, and uses normal live
remounts. Packing is not consent. The real-server verifier proves installation
and door availability; it does not establish useful execution, current broker
access or successful terminal startup. Native dispatch, browser rendering and
actual Code-worker execution need their own smoke evidence.

After an approved build is installed on [the integrated preview](https://preview.manifold.tyrode.dev):

1. In **Plugins → Installed**, enable Code and its desired parts in normal
   **In-realm** mode. Open Code's native machine operations section to inspect
   the exact artifact, owner readiness, per-operation consent and retained jobs.
2. Open **Code** in an editable composition and explicitly choose an online
   machine. No machine is chosen and no job is run merely by mounting a panel.
3. Place **Code accounts** from **F8 → Arrange → Shelf**. Refresh its snapshot,
   then review/apply an import or save an account choice. The expected result is
   a verified new Manifold revision, not a rewritten CLI file.
4. In **Code**, preview the desired dials against that revision. Review routing
   and any suggestion before **Launch reviewed choices**. Expect a native
   terminal tile in the current composition; inspect its output for Code/omp
   readiness. The panel stays open. **Open Code CLI recovery** is separate.
5. Place **Code usage** independently. An explicit refresh starts one governed
   job; completed observations show their provenance and freshness. Offline,
   unsupported, denied and stale states must not look like a successful refresh.

These are acceptance actions, not an assertion that the current preview already
contains this build or its real account bindings. Releases/tags, credential
relocation, broker retirement, production deployment and TUI removal are not
part of this source integration.
