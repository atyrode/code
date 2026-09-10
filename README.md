# Code — `atyrode.code`

**A TypeScript/React/Bun coding-agent plugin inside
[Manifold](https://github.com/atyrode/manifold), using
[oh-my-pi (OMP)](https://github.com/can1357/oh-my-pi) for agent execution.**

Code supplies typed model catalogs, capability ladders, routing and estimates,
shared account choices, suggestions, OMP-owned sign-in and reviewed OMP
launches. The web panels and headless clients use the same governed actions.
There is no standalone Code installation, terminal configuration UI, private
state store or public process ABI to preserve.

## Ownership

| Code | Manifold | OMP |
| --- | --- | --- |
| Domain schemas and validation; routing, catalogs, preferences and account-choice semantics; React panels and typed actions | Fleet identity, grants and consent; durable storage and atomic commits; instance broker placement and scoped services; artifact/binding revisions; jobs, locations, terminals and traces | Provider sign-in, credential storage and refresh; model runtime, ordinary retries and fallback, quotas, session resume and in-session subagent isolation |

Code depends on Manifold and OMP. **Babel is a downstream consumer of Code,
not a Code dependency.** Code exports native headless contracts; Babel adoption
is independent work and is not claimed here. Retaining an old engine protocol
is not a prerequisite for this source cutover.

## Native workflows

- **Code launcher:** initialize container/machine-scoped configuration; edit,
  stage, review and promote a structured catalog; save shared dials; inspect
  routes and estimates; review and promote exact native resource pins.
- **Accounts / Usage:** choose identities or service-scoped credential slots,
  manage shared presets and inspect permitted metadata and usage. Sign-in opens
  the pinned OMP terminal on the declared native instance broker owner; OMP owns
  login, API keys, credential storage and refresh. The broker is shared by
  authorized machines, without owner discovery or failover.
- **Execution:** explicit inventory and benchmark jobs may contact providers and
  incur cost. Per-machine service review/configuration binds the native gateway
  and optional classifier, separately from instance authentication. Suggestions
  use a scoped service. A reviewed launch produces a native terminal runtime;
  Manifold owns admission and terminal lifetime.

The native resource owner must provide reviewed bindings, operation consent,
scoped services and the required `runtimeTools.system` closure. Bun, OMP and
pi-natives are pinned managed artifacts, not host-PATH or cache fallbacks.
Missing resources are unavailable, not evidence of a ready installation.
Workspace/session location bindings do not imply repository cloning or native
worktree preparation has been implemented.

## Development and evidence

Use Bun **1.4.2**, the pinned sibling Manifold checkout, and `scripts/gate.sh`.
The plugin gate is `check`, `test`, `pack`, `verify`; see
[plugin development](plugins/README.md) for exact commands and source maps.

- [Configuration and APIs](docs/configuration.md): current schemas, authority
  and native workflows, not legacy state-format setup.
- [Architecture and transition ledger](docs/manifold-transition.md): #149's
  ratified design and the sole progress ledger, under integration issue #102.
- [Status and caveats](docs/status.md): source versus operational evidence.

This describes the current integration source, **not a claim that it is merged
on main**. The shared preview's dated five-bundle deployment, bounded broker
metadata and runtime-preparation evidence is recorded in
[status](docs/status.md#source-is-not-deployment). That historical deployment does
not certify the current sign-in cutover, provider enrollment or account-backed
runtime and browser workflows.
Production deployment, releases, credential relocation, broker retirement and
destructive data changes require their own authorization.

[MIT](LICENSE) — originally extracted from
[atyrode/dotfiles](https://github.com/atyrode/dotfiles).
