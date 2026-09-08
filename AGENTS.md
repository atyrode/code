# atyrode/code — agent operating contract

Code is a Go launcher for OMP: it previews model routing and starts sessions with
a one-shot configuration overlay. It owns pre-launch selection, a cross-launch
session registry, whole-session worktrees and a contained native RPC engine for
supervising clients. OMP owns the ordinary session runtime. Manifold plugins are
the launcher's transition direction, not proof that the TUI has been replaced.
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

| Command | Use |
| --- | --- |
| `scripts/gate.sh` | Canonical core gate: formatting drift, vet and tests. Extra test arguments are for focused loops, not the full gate. |
| `CGO_ENABLED=0 go build -o <run-owned-path> .` | Build the CLI/TUI to exercise; `code` on PATH may be an installed release, not your change. |
| `code`, `code engine`, `code ls`, `code wt` | Launcher, native RPC, session and worktree entrypoints; see [README](README.md) and [configuration](docs/configuration.md) for their contracts. |
| `code generate init`, `code generate` | Catalog scaffold/probe and render entrypoints. `init` probes real models; it is not an offline fixture command. |
| `code generate refresh --models-file PATH` | Refresh curated facts without regenerating tiers. Defaults to potentially paid live benchmarks; `--skip-bench` is metadata-only and `--bench-json PATH` reuses saved chat measurements. |
| `bun run check`, `bun test`, `bun run pack`, `bun run verify` (in `plugins/`) | Plugin gate; first read [plugin setup and commands](plugins/README.md). |

## Boundaries

- **Runtime and routing ownership.** OMP owns ordinary-session retry, fallback,
  quotas, sandboxing, resume and in-session subagent worktrees. Code owns
  pre-launch estimates, selection, reachability, whole-session worktrees and its
  registry. Reuse `routing.go`/`providers.go`, not parallel provider/pool/lane maps.
  Launches use ephemeral overlays, never edits to OMP configuration; preserve
  forwarded-argument behavior, including `--continue` and replacement of a
  forwarded `--profile` (`launch.go`, `main.go`).
- **Native evidence and refusal.** `code engine` uses an operator-confirmed,
  immutable profile. Profile dials come from the terminal ceremony, not argv or
  environment overrides; configuration without a terminal is refused. Redact
  provider credentials from native RPC, including `rpc_chunk` frames. The atomic
  mode-0600 `code.runtime/1` report precedes the first forwarded byte and records
  exit status/resource use afterwards. Declare only measured, established
  containment; missing required containment means refusal, not a weaker claim
  or weakened escape scenarios. `--describe` is metadata, not runtime proof.
  Closing stdin ends the child tree (`engine.go`, `engineredact.go`, `sandbox.go`).
- **Credentials and launch authority.** Broker tokens travel only in the
  environment. Untrusted, runtime and broker-less launches strip every
  `OMP_AUTH_BROKER_*` key and `CODE_AUTH_ACCOUNT_STATE`; the DeepSeek key stays
  in memory, never serialized. Preserve the mode-0600 account pool, private
  mode-0700 session directory and cleanup in `vault.go`. Secrets stay local, never
  in Manifold; launch authority stays on the spoke. Plugin owner keys must not
  enter argv, logs or committed files, or be copied between machines.
- **Public and persistent compatibility.** CLI and `CODE_*` contracts protect
  separately released callers, including dotfiles' `codeLauncher`; change them
  only with coordinated downstream migration. Preserve profile references and
  immutable revisions: profile import copies exact revisions, rejects conflicts
  and leaves its source untouched. Legacy worktrees remain discoverable and
  removable, without silent relocation or migration. Internal cutovers remove obsolete
  callers/paths; public or persistent migration and rollback support remains
  until its coordinated transition completes.
- **State and privacy.** Code worktrees belong under Code's state root, never
  OMP's worktree root: OMP cleanup does not know Code's liveness registry. OMP
  owns writes to its session store. History reads only leading session metadata,
  never conversations, prompts or tool output, and never untrusted `ompu` roots.
  [Configuration](docs/configuration.md), `worktree.go` and `history.go` own state
  paths, overrides and resume behavior; do not create a second root inventory.
- **Availability and safe verification.** Missing providers must not crash the
  launcher; unavailable features hide or degrade. Ordinary tests stay offline
  and deterministic using existing seams. Required containment, native canary
  and opt-in upstream drift lanes are explicit exceptions, not permission for
  incidental live probes.

## Task-specific guidance

- **Native runtime or containment changes:** read `scripts/gate.sh`,
  `.github/workflows/ci.yml` and the affected native tests for prerequisites and
  required evidence flags; `nix/omp.nix` owns Code's optional standalone bundle
  pin and required CI runtime. Dotfiles owns managed machine runtime and
  configuration; do not add a cross-repository build dependency. Containment,
  pinned registry/config smoke and latest-upstream drift are separate
  measurements, not substitutes. Local skips remain unverified unless
  identified CI evidence supplies the missing measurement; never opt required
  evidence out. Use `TestOmpSmoke` and the README's compiled-runner invocation
  for deployed configured-OMP verification, and `.github/workflows/omp-smoke.yml`
  for latest-upstream drift. Dotfiles owns the complementary packaged Code/OMP
  interactive startup check.
- **Launcher/TUI transition work:** read the recorded direction and decisions in
  [the transition document](docs/manifold-transition.md) before extending the
  launcher. New launcher capabilities must be reachable headlessly rather than
  TUI-only; new rendering belongs on the plugin surface, not a new Bubble Tea
  surface. Preserve the working TUI until its replacement is proven end to end.
  Planned verbs, doors and projections are not available merely because the
  dated record describes them; check current code and published evidence.
- **Terminal rendering or interaction changes:** use the
  `tui-visual-verification` skill for actual interaction and rendered capture,
  including affected transitions; render-function tests alone are insufficient.
  The skill owns the terminal recipe and resource cleanup, not this root.
  Catalog changes use `TestGoldenCatalogTwoPool` and
  `testdata/two-pool-golden.plain`; deliberately update and review that fixture.
- **Configuration or local classifier changes:** read
  [configuration](docs/configuration.md) and the owning implementation rather
  than copying command/environment maps. `suggest.go` consumes cli-kit's default
  model; coordinate changes affecting dotfiles' classifier/wrapper integration
  with that owner rather than introducing a second default here.
- **Plugin changes:** first read [plugins/README.md](plugins/README.md) and
  Manifold's `docs/PLUGINS.md` §9. They own SDK checkout/install, packing,
  normal/hardened disposable-real-server verification and delivery procedures.
  Use frozen dependency installs for both SDK and plugins; update
  `plugins/MANIFOLD_REV` and the reusable-workflow ref in
  `.github/workflows/manifold-plugins.yml` atomically. Adapt to Manifold's mechanisms;
  raise genuine platform gaps with its owner rather than building a parallel
  mechanism. Before ready/merge, complete applicable plugin CI and both server
  modes; normal admission alone does not prove a Worker panel mounts, and a
  bundle build is not installed-browser proof.
- **Authorized preview work:** use the plugin owner's delivery procedure only
  with explicit task authority for live mutation. Inspect current preview
  configuration and the live machine roster, then verify the installed browser
  surface and affected interaction after reload. Do not assume a machine is
  online or substitute a local bundle for installation evidence. Production
  installation is operator-only, by hand from the release URL in the plugin
  manager, root only, never automated.
- **Release work:** read `.github/workflows/release.yml`, `.goreleaser.yaml` and
  the plugin README's receiver prerequisite before publishing: an SDK pin does
  not update the receiver, and a tag may trigger preview mutation. After release,
  `scripts/bump-flake-pin.sh <tag>` prepares the pin update for a PR; `flake.nix`
  and `nix/code.nix` wrap published binaries, not a Code source build. Published
  tags are immutable, including cli-kit dependency tags; fix a bad release with
  a new patch, not tag movement/deletion.

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
- For transition work, §6 of `docs/manifold-transition.md` is the sole progress
  ledger; the PR advancing a step updates its row. Treat the document as dated
  decisions/evidence, and `docs/status.md` as caveats, not another progress map.
  Do not call planned or unpublished CLI/plugin work shipped.
- Release publication, preview installation, production installation, downstream
  pin updates and machine activation are distinct evidence. A tag proves no
  installed client updated and gives no update-time guarantee. For plugin review,
  report the observed hub/surface, action and expected result, plus any residual
  verification boundary; identify a live machine only when the interaction needs
  one. Neither documentation nor a release grants production authority.
