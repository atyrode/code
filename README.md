# Code — `atyrode.code`

**The opinionated OMP launcher inside
[Manifold](https://github.com/atyrode/manifold), using the independent
[`atyrode.omp`](https://github.com/atyrode/manifold-omp) plugin for governed
agent execution.**

Code's TypeScript/React plugin supplies typed model catalogs, four-level capability
ladders, routing and estimates, shared account choices, suggestions and the workbench.
Its web panels and headless client use the same typed Code/OMP workflow. There is no standalone
Code binary, machine runtime, broker, gateway, credential store or public
process ABI.

## Ownership

| Code | Manifold | OMP |
| --- | --- | --- |
| Domain validation; routing, catalogs, container preferences and account-choice semantics; suggestion policy; React panels and typed caller workflow | Fleet identity, grants and consent; durable storage and migrations; artifact/binding revisions; jobs, locations, terminals and traces | Native broker/gateway placement and service policy; provider sign-in, credential storage and observations; workspace/probe/session operations; model runtime, retries, fallback, quotas and session resume |

Code depends on Manifold and the separately versioned `atyrode.omp` plugin and
typed client package. **Babel is a downstream consumer of Code, not a Code
dependency.** Its adoption is independent work; no old Code engine or runtime
protocol is retained for it.

Code owns custom launch and continuation choices; OMP supplies the runtime
primitives that execute them. Moving the launcher into Manifold does not move
its product policy into OMP. The retained continuation scope is native fleet
metadata, exact terminal reopening, native resume and explicit next-resume
choices. The skill, automation and continuation additions are source-only,
not included in a published release; see [availability boundaries](docs/status.md#explicit-availability-boundaries).
Portable archives, general live settings-origin inspection, live per-account
quota preservation and Code-owned upstream fallback repair are not planned.

## Native workflows

- **Code workbench:** one main view in the terminal's grammar. The **generator** is
  one row of plain words per setting (lane, model, thinking, advisor, and an on/off
  row per extra) changed in place by pointer, keys or wheel, each model shown by its
  short alias per tier, with a readout line that says what a pointed word does,
  including to quota where it strands a role or leads on a strained pool. Cost and
  speed meters sit above a launch row that names the next step (Verify models, Save &
  launch, Launch) and the machine it runs on, a picker over the roster; when the step
  is refused it stays focusable and the launch line gives the reason with a fix.
  **Routing** beside it lists every role's `model:thinking`, with the fallback chains
  on request, and **usage** under both. A key line names the keys of the view shown.
  The **accounts** (`a`, with their management under `m`) and the **sessions** (`e`)
  are views one key away, and routing and usage are views of their own below 760 px.
  The sessions list running and explicitly read saved sessions and this device's
  recent profiles. Launch is task-less: the task is typed in the session. Empty
  workspaces derive a render-only starter from OMP's passive bundled model metadata,
  so exploring needs no models, credentials or runtime setup; saving starts with
  **Verify models**. Stored active policy always wins. Models (manual authoring,
  import/export, discovery and measurement), Setup and the session options, which
  hold skills and automation for one launch, open as sheets. An unsaved profile
  survives a reload in the tab.
- **Accounts / Usage:** include exact OMP-observed identities or credential slots
  with a switch per account in the accounts view, choose among reusable presets, and
  manage presets, sign-in and credentials in its management view. The usage pane
  reads each reported quota window separately and again every five minutes, or on
  `r`; unknown and historical facts never imply free capacity.
  OMP owns the broker, sign-in, credential mutation and gateway.
- **Workspace / probes / sessions:** the shared headless workflow opens exact
  OMP native reviews, re-observes current revisions before preparation, and
  returns OMP's retained job receipts or terminal descriptor. Explicit
  inventory and benchmark jobs may contact providers and incur cost.
- **Optional skills:** inspect OMP's authorized immutable skill catalog and
  deliberately select entries or sets for one launch. Review purpose, source,
  license and review provenance; resolve stale or conflicting choices before
  launch. Clearing optional choices preserves ordinary loading; disable-all
  suppresses it. Choices are ephemeral, never shared profile defaults, and a
  selected skill is not evidence that OMP invoked it.
- **Restricted automation:** deliberately choose a native-supported tool subset
  for one launch or resume. OMP enforces its effective reviewed policy, disables
  OMP task/advisor spawning and ambient skill discovery, and loads only selected
  sealed skills. Ordinary launches remain the default. Skills grant no authority;
  permitted bash retains subprocess authority, so tool limits are not an OS sandbox.
- **Native fleet sessions:** explicitly read bounded header/title metadata from
  each permitted machine. An exact harness/machine/session correlation can reopen
  its existing terminal at its authoritative current home; similar names or
  directories never imply a match. Otherwise choose **resume** or **with current
  profile** on a saved session; resuming runs on the launch row's machine. The
  latter sends explicit next-resume model/thinking choices and the exact composed
  overlay/account pool, not a claim about live effective settings. Resume rechecks
  native inventory
  and running terminals before preparing anything; native refusals and placement
  permissions remain authoritative. Recent profiles are device-local and grant nothing.
- **Suggestions:** Code reviews and invokes only its optional external
  classifier service, configured in Setup; the main view has no Suggest control.
  This policy is separate from OMP account and gateway configuration.

Native Plugins installs and governs OMP's root, accounts and gateway bundles,
managed resources, locations, service bindings and operation consent. Code has
no duplicate runtime pins or machine declarations. Missing resources, caller
authority or consent remain explicit refusals; a checked box, installed bundle,
retained job or terminal placement is not provider success.

## Development and evidence

Use Bun **1.4.2**, the pinned sibling Manifold checkout, the exact OMP Git client
pin and `scripts/gate.sh`. The gate prepares real OMP bundles, then runs Code's
`check`, `test`, `pack` and disposable-server/browser `verify`; see
[plugin development](plugins/README.md).

- [Configuration and APIs](docs/configuration.md): current schemas, authority
  and native workflows, not legacy state-format setup.
- [Architecture and transition ledger](docs/manifold-transition.md): #149's
  ratified design and the sole progress ledger, under integration issue #161.
- [Status and caveats](docs/status.md): exact source and preview evidence.

The 2026-09-13 preview acceptance installed the pinned independent OMP bundles,
preserved the existing account store, and completed native workspace, inventory
and account-backed terminal paths on two separately enrolled destinations.
Source merge still authorizes neither production deployment nor release,
credential relocation, backup disposal or other destructive data changes.

[MIT](LICENSE).
