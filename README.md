# Code — `atyrode.code`

**A TypeScript/React policy and presentation plugin inside
[Manifold](https://github.com/atyrode/manifold), using the independent
[`atyrode.omp`](https://github.com/atyrode/manifold-omp) plugin for governed
agent execution.**

Code supplies typed model catalogs, four-level capability ladders, routing and
estimates, shared account choices, suggestions and the workbench. Its web panels
and headless client use the same typed Code/OMP workflow. There is no standalone
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
- [Status and caveats](docs/status.md): source versus operational evidence.

This describes integration source, not a claim that it is merged or deployed.
The historical five-Code-bundle preview predates the separate OMP owner and does
not certify this cutover, current consent, provider enrollment or an
account-backed session. Production deployment, releases, credential relocation,
broker transfer and destructive data changes require separate authorization.

[MIT](LICENSE).
