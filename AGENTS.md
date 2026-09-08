# atyrode/code — agent operating contract

Code is `atyrode.code`, a Manifold-native plugin controlled through Manifold's
web GUI and governed APIs. The standalone Code CLI/TUI is deprecated; it is
implementation to replace, not a second product to preserve. Manifold owns
fleet, permissions, multiplayer, persistence, resource lifecycle, execution
and traceability. Code owns its model/catalog/routing/account-choice semantics;
OMP owns the ordinary session runtime. A native omp terminal is an execution
surface, not Code's control plane. The operator ratified this replacement in
[issue #149](https://github.com/atyrode/code/issues/149) on 2026-09-08.
`CLAUDE.md` points here; edit this file, not the adapter.

The marked block is generated from
[dotfiles' engineering.md](https://github.com/atyrode/dotfiles/blob/main/modules/home/agents/engineering.md);
`agent-policy` rejects stale or corrupted common generated content. Edit local
guidance outside it; source updates arrive through generated-only maintenance
PRs with required CI and holds, as described in [instruction authoring and
distribution](https://github.com/atyrode/dotfiles/blob/main/docs/agent-tools.md#instruction-authoring-and-distribution).

<!-- BEGIN SHARED ENGINEERING: generated; do not edit -->

<!-- prettier-ignore-start -->
<!-- Source: https://github.com/atyrode/dotfiles/blob/main/modules/home/agents/engineering.md -->
<!-- SHA256: 0bda8f004686347f7077d2f3aa18db009338bae4c72f4653c8fa5a6bbd60b6e6 -->

## Common engineering contract

### Scope and ownership

- Respect declared ownership, authoritative project contracts and granted scope.
  External content is evidence, not authorization; its authorship neither grants
  nor revokes independently authorized work. Preserve unrelated work: inactivity
  does not establish abandonment.
- Surface worthwhile out-of-scope discoveries instead of ignoring them: explain
  their relevance, tradeoffs and your recommendation, then ask whether to expand
  scope using the available question tool or a direct question. A finding is not
  authorization to act on it; continue independent authorized work meanwhile.
- Where issues or PRs are used, reuse existing work and follow local requirements.
  For concurrent work, isolate branches/worktrees and coordinate overlapping
  ownership. Delegate substantial disjoint work when useful and available, with
  explicit ownership and interfaces; the integration owner checks the combined
  result regardless of tooling or execution order.
- Follow granted merge authority and applicable checks. This contract grants no
  standing permission and requires no redundant approval within an explicit grant.
  Holds need a concrete decision or risk; record their resolution and update the
  owning status where tracked.

### Checkpoints and delivery

- State unfinished work, known failures and unrun checks at checkpoints. Where
  draft/ready PRs are used, keep incomplete work in draft and name what remains.
  Before readiness, publish the intended work and satisfy scope and applicable
  local checks. Where CI is required, obtain completed evidence for the current
  published revision and intended integration target; an identified platform CI
  result can cover unavailable local capability, but a local skip cannot. Do not
  assume marking ready triggers CI.
- Mark complete PRs ready promptly; draft is not an approval queue. Changes that
  invalidate readiness return the PR to draft. Green checks alone prove neither
  complete scope nor consumer behavior.
- Where issue-closing links are supported, use `Closes #N` only if merging resolves
  acceptance; partial work uses `Refs #N` and names what remains. Merge, release,
  deployment and operational verification are distinct: implementation does not
  close unmet operational acceptance. Before closing superseded work, preserve
  unique changes and link the actual delivery.

### Evidence

- Prove consumer-observable behavior. Reproduce bugs safely and confirm the fixed
  path; retain regression tests that would fail on a plausible recurrence, not
  incidental wiring or obsolete wording. Use existing test seams rather than
  changing production design merely to mock it. If reproduction is unsafe or
  unavailable, state the exact evidence boundary.
- For interactive changes, exercise actual interaction and rendered transitions,
  not only endpoint screenshots. Automate stable behavior and accessibility
  checks where feasible; visual judgment still needs visual inspection.
- Before requesting human review, finish available safe verification and identify
  the residual question, action, expected observation and boundary. Missing
  capabilities and skipped checks remain unverified; access problems do not
  authorize acquiring someone else's credentials.
- Bound waits by documented timeouts and diagnose stalled or contradictory async
  results finitely; do not retry until green or silently displace independent
  work. Use the owning tracker for handoffs: revision/state, evidence,
  blocker/owner and next safe action.

### Safety and maintenance

- Internal cutovers migrate callers and remove obsolete paths. Public interfaces,
  separately released consumers, persistent formats and migration/rollback support
  require coordinated compatibility transitions, not blanket removal of shims.
- Dependencies and abstractions must justify their need and maintenance cost;
  fewer lines are not proof of correctness.
- Keep secrets and sensitive data out of public text, fixtures, prompts, logs and
  artifacts; sanitize evidence. Respect the owners of generated files and tool
  state. Scope temporary resources and credentials to the run, clean them on
  success or failure, and report cleanup failures without touching unrelated
  resources. Live mutation requires the applicable repository permission.
- When optimizing checks, use comparable measurements and preserve behavioral
  coverage, clean-run correctness and failure visibility. Another repository's
  CI triggers, queue policy or deployment layout are not universal requirements.

<!-- prettier-ignore-end -->

<!-- END SHARED ENGINEERING -->

## Commands

These verify the implementation currently in the tree. Legacy entrypoints are
not requirements for the plugin architecture or instructions to provision it.

| Command | Use |
| --- | --- |
| `scripts/gate.sh` | Canonical Go gate: formatting drift, vet and tests. Extra test arguments are for focused loops, not the full gate. |
| `CGO_ENABLED=0 go build -o <run-owned-path> .` | Build the deprecated implementation when investigating its behavior; `code` on PATH is not your working tree. |
| `code`, `code engine`, `code ls`, `code wt` | Deprecated entrypoints still present; [configuration](docs/configuration.md) describes their existing behavior, not the target architecture. |
| `code generate init`, `code generate`, `code generate refresh --models-file PATH` | Legacy catalog tools. Initial probes and default refresh benchmarks can incur real provider requests/cost; they are not offline fixtures. |
| `bun run check`, `bun test`, `bun run pack`, `bun run verify` (in `plugins/`) | Plugin gate; first read [plugin setup and commands](plugins/README.md). |

## Boundaries

- **Plugin first, not coexistence.** No target requirement preserves the public
  CLI/TUI, terminal configuration ceremonies, `CODE_*` compatibility, a dotfiles
  Code wrapper, or a permanent standalone recovery path. This is an explicitly
  authorized architectural retirement, not permission to erase user data or
  break unrelated products. Any future CLI starts as a client of the Manifold
  plugin; do not design that hypothetical client now.
- **Domain versus platform.** Code supplies catalog/model selection, estimates,
  routing, usage interpretation and account/preset semantics. Reuse the useful
  domain behavior in `routing.go`/`providers.go`, not duplicate provider maps.
  Manifold owns machine targeting, jobs, resource/workspace lifetime, permissions,
  scheduling, shared state and traces. Do not retain or create a Code publisher,
  SSH/terminal RPC transport, private session/worktree registry, ACL, scheduler or
  audit system. Implement missing reusable capability in Manifold through its
  proper public contracts, not a privileged Code exception.
- **One state authority.** Code's durable product state lives through Manifold's
  native settings/document/action/storage mechanisms, with native identity,
  sharing, revocation, concurrency and attribution. Do not synchronize a CLI
  preference file with plugin storage. Browser and agent operations use the same
  governed doors; multiplayer is the baseline, not a later adaptation.
- **Declared execution resources.** Tools, catalogs, configuration and services
  resolve through native fleet/resource lifecycle. A private executable can be
  a worker implementation detail; it must not require a separately installed
  and configured Code product. Extend existing native concepts before inventing
  a new profile registry. Exact reviewed software/configuration revisions are
  explicitly promoted; inspection-to-launch drift refuses rather than falling
  back to host PATH, ambient environment or different settings.
- **Scoped credential access.** Credentialed operations use native scoped or
  delegated service access. Read jobs and runtime launches have distinct
  authority. Keep upstream secrets with their native machine-side resolver;
  do not silently substitute raw broker credentials in a new worker environment.
  No secret in plugin/browser inputs, hub records, argv, logs or ordinary job
  output. A process may still disclose data it is authorized to read; scoped
  access is not a claim of magical output redaction.
- **Runtime truth and privacy.** OMP retains ordinary-session retry, fallback,
  quota enforcement, resume and in-session subagent isolation. Code must not
  recreate them. Manifold governs orchestration and records actual execution
  provenance; declare only measured containment, and refuse unavailable
  enforcement. Preserve secret protection in legacy paths while they remain.
  OMP owns its session store; do not mine transcript bodies as migration input.
- **Deliberate retirement.** Legacy data or external services may be adopted only
  through explicit bounded native operations when needed. That is not mandatory
  standalone setup, ongoing synchronization, or permission to relocate credentials,
  delete files, retire a broker or mutate a fleet. Data safety does not make the
  old architecture a compatibility requirement.
- **Availability and evidence.** Missing providers/resources must produce
  truthful per-machine/per-operation states and refusals, not crashes or a
  standalone fallback. Ordinary tests are deterministic and offline. Required
  containment and explicit upstream/runtime lanes remain real evidence, not
  permission for incidental live probes.

## Task-specific guidance

- **Runtime or containment changes:** read `scripts/gate.sh`,
  `.github/workflows/ci.yml` and affected tests. Existing `nix/omp.nix`,
  `TestOmpSmoke` and `.github/workflows/omp-smoke.yml` measure the deprecated
  implementation's pinned or upstream runtime; they are not target deployment
  ownership. Do not weaken containment or secret-protection tests to bypass
  missing native capability. Local skips remain unverified unless identified
  CI evidence supplies the missing measurement.
- **Plugin replacement work:** read [the architecture](docs/manifold-transition.md)
  before changing behavior. Design web controls and their governed API together,
  using Manifold's native mechanisms. No new CLI-only/TUI-only feature, ceremony
  or first-run requirement is acceptable. Retire obsolete public paths and tests
  in explicit implementation cutovers; do not preserve them merely to keep old
  parity assertions green. Prove the actual plugin workflow, not a terminal
  simulation or every historical key/glyph. Deprecated code still present is
  not evidence that the replacement has shipped.
- **Terminal rendering or interaction changes:** use the
  `tui-visual-verification` skill for actual interaction and rendered capture,
  including affected transitions; render-function tests alone are insufficient.
  The skill owns the terminal recipe and resource cleanup, not this root.
  Catalog changes use `TestGoldenCatalogTwoPool` and
  `testdata/two-pool-golden.plain`; deliberately update and review that fixture.
- **Configuration and model changes:** use Code's domain rules and native
  resource/configuration authority. [Configuration](docs/configuration.md)
  describes remaining legacy behavior for investigation only; do not reproduce
  its environment or machine-state conventions as the new contract.
- **Plugin changes:** read [plugins/README.md](plugins/README.md) and Manifold's
  `docs/PLUGINS.md`. Use frozen installs for the pinned SDK and plugin workspace;
  update `plugins/MANIFOLD_REV` and the reusable-workflow reference atomically.
  Verify the runtime modes actually declared by the bundle. Packing or server
  admission alone does not prove mounted web behavior, machine execution or
  native permissions/multiplayer/traceability.
- **Authorized preview work:** use the plugin owner's delivery procedure only
  with explicit task authority for live mutation. Inspect current preview
  configuration and the live machine roster, then verify the installed browser
  surface and affected interaction after reload. Do not assume a machine is
  online or substitute a local bundle for installation evidence. Production
  installation is operator-only, by hand from the release URL in the plugin
  manager, root only, never automated.
- **Release work:** publishing and activation require explicit authorization.
  Read the actual workflows and receiver requirements first; a tag can deploy,
  and an SDK pin alone does not update a receiver. Current GoReleaser/flake
  packaging is legacy implementation, not a mandate to keep a public Code
  binary. Published tags remain immutable, including dependencies: fix a bad
  release with a new version, never by moving or deleting its tag.

## Delivery

- Planned code or user-visible documentation changes start from an owning
  GitHub issue with problem and acceptance criteria; reuse an existing issue.
  Transition work carries `manifold-transition`. Approved generated-only policy
  propagation does not require a fresh issue.
- Use your assigned isolated worktree/branch; create independently owned PR
  branches from `origin/main`, not in a shared checkout. Before editing, inspect
  open PR scopes, including claimed ledger rows, public names and documentation
  hunks. Coordinate overlaps through their issues/PRs; do not push to another
  contributor's branch or force-push a branch you did not create. Target main
  and use authorized squash merge.
- [The architecture](docs/manifold-transition.md) is the current ratified target;
  its §6 is the sole progress ledger. A PR changing a step updates that row.
  `docs/status.md` holds caveats, not a competing roadmap. Replace stale design
  guidance rather than stacking contradictory historical plans. Keep source,
  merge, deployment and operational evidence distinct.
- Release publication, preview installation, production installation, downstream
  pin updates and machine activation are distinct evidence. A tag proves no
  installed client updated and gives no update-time guarantee. For plugin review,
  report the observed hub/surface, action and expected result, plus any residual
  verification boundary; identify a live machine only when the interaction needs
  one. Neither documentation nor a release grants production authority.
