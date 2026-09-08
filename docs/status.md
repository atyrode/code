# Status & caveats

Code's product direction is **`atyrode.code`, a Manifold-native plugin
controlled through the web GUI**. The existing standalone CLI/TUI is
**deprecated**, not a supported companion architecture to preserve until
feature parity. [Issue #149](https://github.com/atyrode/code/issues/149)
records the operator-ratified correction.

The [architecture document](./manifold-transition.md) owns the design and
its [section 6](./manifold-transition.md#6-transition-steps) is the sole
transition ledger. This page records evidence boundaries and constraints,
not a second checklist or progress tracker.

## What the available evidence establishes

- **Source baseline:** `origin/main@288190f` still contains the legacy Go
  CLI/TUI and bootstrap plugins. Their presence demonstrates existing
  implementation, not acceptance of the target architecture. In particular,
  opening the old launcher in a Manifold terminal is not the native GUI product.
- **Candidate work:** [draft PR #148](https://github.com/atyrode/code/pull/148)
  contains candidate headless, React and native-job work. It needs rework under
  #149 because its coexistence assumptions are rejected. A draft is neither
  merged implementation nor operational acceptance.
- **Target contract:** native scoped service access, explicit promotion of
  exact revisions and one Manifold-owned source of Code state are ratified
  requirements. This documentation does not claim they are fully implemented.
- **Operational boundary:** no supported native installation, preview readiness
  or live end-to-end acceptance is established by these documents. Existing
  packaging, CI or deployment mechanics do not establish those claims either.
  Evidence must identify the revisions and the actual path exercised; a
  passing local check cannot stand in for a live acceptance result.

The [plugin guide](../plugins/README.md) is the development entry point.
The [configuration reference](./configuration.md) is explicitly deprecated
implementation documentation, not instructions for setting up the target
product. Historical commands, wrappers, state paths and screenshots describe
the old implementation only.

## Domain and runtime constraints worth retaining

### Model catalogs and estimates

Code owns capability ladders and coding-role routing, not a new execution
platform. Model metadata alone does not establish that an account can call a
model. The legacy generator's reachability probes are useful implementation
reference: an unavailable model, an incompatible client and an inconclusive
probe are distinct outcomes. An inconclusive request must not be presented as
successful verification or silently certify the remaining ladder.

Automatically inferred tier assignments still require domain review.
A single timed request is a sample, not a sustained throughput benchmark;
cost and speed previews are estimates, not promises. A local endpoint listing
a tag proves neither its reasoning quality nor its fitness for a task. Do not
present local models as capability-verified merely because the endpoint answers.

OMP model, usage and benchmark schemas and upstream provider behavior can
change. Compatibility claims must name the versions and exercised contracts;
a historical version number is not a current guarantee.

### Quotas and account health

Routing should use declared model quota buckets rather than assume that model
family names encode entitlement. Provider-wide headroom and tier-scoped quota
windows are different signals: a usable sibling account can supply provider
capacity without proving that a particular tier has capacity. A stale,
retired quota window must not be advertised as spendable capacity when no
model uses it.

Disabled credentials, missing usage reports, exhaustion and stale broker
blocks are not interchangeable. Missing data is not evidence of health or
entitlement. Code can interpret authorized service observations for domain
previews; it must not create an independent account-health authority or
private enabled-account preference store beside Manifold state.

### Execution, recovery and safety

Manifold owns fleet placement, permissions, multiplayer/shared state,
persistence, resource lifecycle, execution, scheduling and traces. Code owns
the coding-domain actions using those services. OMP provides agent runtime
behavior, including retries and model fallback; its terminal is an execution
surface, not Code's control plane. Generic gaps must be fixed in Manifold,
not filled with Code-owned parallel machinery.

The legacy session registry and separate worktree root record real safety
concerns: cleanup must not delete live work, orphan child processes, erase
uncommitted changes or mistake a missing worktree for permission to recreate
it. Preserve those protections in Manifold-owned lifecycle and recovery
contracts, **not** by retaining Code's registry, private persistence or CLI
recovery indefinitely. Existing state is not authorization to migrate or
remove it.

Legacy/external brokers and runtimes may remain governed native resources
when required. They must be reached through scoped native service access;
that does not make standalone installation, `CODE_*` variables, a personal
wrapper or dual state part of the target. Internal domain workers are
implementation details, not separately configured operator products. Any
future CLI would be a Manifold client, with no requirement to preserve the
current command surface.

## Promotion is a separate operator decision

Development and architecture changes do not authorize live deployment,
releases, credential relocation, broker retirement or destructive state
changes. Promotion requires explicit selection of exact revisions. Do not
interpret a branch, a moving tag, an old preview workflow or a successful
local build as permission to change a running environment.
