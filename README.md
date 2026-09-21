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

- **Code workbench:** initialize container-scoped configuration; edit, stage,
  review and promote a structured catalog; save shared dials; inspect routes and
  estimates. Changing the execution destination preserves shared choices,
  prompts and drafts.
- **Accounts / Usage:** choose exact OMP-observed identities or credential
  slots, manage shared presets and inspect selected capacity with source age and
  refresh status. OMP owns the shared broker, sign-in terminal, observations,
  credential mutation and gateway.
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
  directories never imply a match. Otherwise choose **Resume saved state** or
  **Resume with this profile** on the selected destination. The latter sends
  explicit next-resume model/thinking choices and the exact composed overlay/account
  pool, not a claim about live effective settings. Resume rechecks native inventory
  and running terminals before preparing anything; native refusals and placement
  permissions remain authoritative.
- **Suggestions:** Code reviews and invokes only its optional external
  classifier service. This policy is separate from OMP account and gateway
  configuration.

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
