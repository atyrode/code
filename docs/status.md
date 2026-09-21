# Status and caveats

Code is `atyrode.code`, a TypeScript/React policy and presentation plugin within
Manifold. The independent
[`atyrode.omp`](https://github.com/atyrode/manifold-omp) plugin owns its native
runtime. [#149](https://github.com/atyrode/code/issues/149) records the ratified
replacement and [#161](https://github.com/atyrode/code/issues/161) its current
cross-repository integration. The
[architecture's section 6](manifold-transition.md#6-transition-steps) is the sole
transition ledger. This page records constraints, not another roadmap.

## Integrated source and preview acceptance

The integrated source contains four Code bundles: container-CAS
catalog/routing/account-choice/suggestion policy and the launcher/accounts/usage
React surfaces. It imports the typed OMP caller package and has no machine
manifest, broker, gateway, probe workers or runtime artifact pins. The shared
headless workflow calls OMP's public owner-scoped actions through ordinary
Manifold dispatch, rechecking Code composition, OMP defaults, destinations and
native review pins before effects.

The 2026-09-13 source gate pinned Manifold
`c731aa2364531ec6cf14e6ffb13c3a806dff9f6b` and OMP
`19223eb4d08ad8aef70b31fb8ff9d716d91e597b`. It passed 87 Code tests with
530 assertions, packed and verified all three OMP and four Code bundles, and
drove two independent real browser identities. The browser proof covered shared
state convergence, draft and navigation retention, first-use recovery,
responsive and keyboard interaction, permission refusal and stale or
cross-destination review fences.

The same revisions were then accepted on the preview through native actions.
OMP's root, account and gateway deployments reached ready on `dev-01` and the
separately enrolled `Code isolated destination`. Both destinations validated a
real workspace, produced a readable 11-model inventory from the complete saved
account pool and opened account-backed OMP terminal sessions with output. The
actual Code panel rendered the permitted online and offline destinations and,
because no classifier service is configured, withheld rather than faked its
suggestion control.

The shared OMP broker now has one runtime owner. Existing account identities,
saved choices and legacy Code/Usage clients continued across the reviewed
transfer and restart without reauthentication; a legacy client completed a
fresh quota observation afterward. Run-scoped credentials and grants were
revoked after each proof. Existing credential backups were retained, and no
production deployment, backup disposal or personal-session mutation occurred.

See [plugin development](../plugins/README.md) for the Bun 1.4.2 and pinned
Code/OMP/Manifold gate, and [configuration](configuration.md) for the exact
actions. Source retirement does not authorize moving or deleting existing user
files, service state, credentials or backups.

## Explicit availability boundaries

- OMP's managed Bun, SDK and pi-natives pins do not themselves supply an
  owner's independently reviewed system or development closure. Missing
  artifacts, bindings, consent, scoped service access or connectivity stay
  unavailable; host PATH, ambient files and caches are not fallbacks.
- The accounts owner alone reviews/configures broker runtime and places sign-in.
  Ordinary authorized users may read permitted account/usage observations
  without gaining setup authority. There is no owner discovery, failover or
  private Code credential form.
- The gateway owner alone reviews/configures the destination service. Code's
  service actions bind only the optional external suggestion classifier.
  Neither path grants account authority or supplies credentials.
- Pure catalog/preferences actions need no machine process or selected account.
  `composeProbe` and `composeSession` consume typed caller-supplied OMP
  observations but do not attest them; OMP rechecks concrete account slots before
  execution.
- OMP workspace, inventory, benchmark and session preparation produce native
  reviews, jobs or terminal descriptors. Admission and placement are not
  successful OMP/provider execution; verify output, cancellation and reconnect
  before claiming them.
- Code's headless client and web use the same ordinary dispatch workflow. Babel
  is a potential downstream consumer, not a Code dependency or acceptance
  shortcut; no old process ABI is retained.
- Optional skills come only from OMP's authorized immutable catalog and native
  review. Code's workbench and headless workflow pass an ephemeral launch choice;
  they do not discover host paths, download third-party skills, grant source-job
  access or claim invocation. The disposable browser fixture has no sealed skill
  source jobs: its real catalog is empty. Real-browser scenarios cover clear/disable-all,
  refresh/navigation retention and destination/review invalidation. Separate synthetic
  metadata exercises set expansion, deduplication, conflicts and stale catalog revisions;
  it does not establish governed source admission or selected-skill execution.
- Restricted automation source consumes OMP's shared schemas and supported tool
  subset, displays native effective review policy and carries it to preparation
  and one-shot posting. OMP's SDK registry is the enforcer, not a Code-side filter.
  Ordinary new sessions remain unchanged. Selected skills are instruction-only;
  restricted ambient discovery and OMP task/advisor suppression are not OS sandboxing;
  permitted bash retains subprocess authority.
- Native fleet source reads bounded title/header metadata separately on each
  permitted machine, keeping not-requested, pending, failed, unavailable, empty
  and ready states distinct. Only an exact harness/machine/session correlation
  exposes a running terminal and its authoritative home. Legacy absence means
  unknown activity, not a stopped session or an inferred workspace.
- Preserve-state resume and explicit current-profile model/thinking choices are
  separate. Both re-observe native metadata and public terminals; a newly observed
  running match reopens through the public terminal URI instead of creating a
  replacement. Profile choices describe the next resume, not live effective state.
- Disposable real-browser scenarios exercise fleet metadata, authoritative
  reopening, independent machine failure/offline state, stale-response fencing,
  preserve-versus-explicit inputs and native refusals using synthetic RPC responses.
  They do not establish provider execution, governed consent or a qualified native
  dependency pin.
- Separate packaged native proof covers 20 offline scenarios using the published
  CLI/SDK programs: fresh selected/disabled skills, authoritative project filters,
  sealed resource reads, restricted tools, native resume, explicit model/thinking
  precedence, missing/changed-state refusal and cancellation. Synthetic inference
  in isolated network namespaces is not paid-provider or live-fleet acceptance.
- The credential runtime retains its 18.1.14 graph and existing patch; the SDK
  host has an independent, unpatched 18.2.7 graph. Native lifecycle accounting
  uses public SDK hooks and passes the retained deadline/quiescence regressions
  without copying credential algorithms or changing that patch. This does not
  qualify the separate unpatched credential migration in
  [manifold-omp#72](https://github.com/atyrode/manifold-omp/issues/72).
  Code pins the merged native source at
  [`c4898f0`](https://github.com/atyrode/manifold-omp/commit/c4898f0ff057c0a94ab0109953872420b4d9051e)
  ([manifold-omp#74](https://github.com/atyrode/manifold-omp/pull/74)).
  Source integration requires both plugin gates against the declared native pin
  and current CI. These additions are not in a released Code/OMP bundle, and no
  transition-ledger row advances.
- Portable captures/archive recovery, general live settings-origin inspection,
  live per-account quota preservation and Code-owned upstream fallback repair are
  not planned. Bounded Babel acceptance remains separate and unproven.

## Domain and safety constraints

### Catalogs and estimates

Code owns ladders and routing, not provider entitlement. Metadata, a reachable
endpoint or an inventory entry does not prove model quality or callability.
Unavailable, incompatible and inconclusive probes are distinct. Automatically
assigned tiers require review; a timed request is a sample, not a sustained
throughput guarantee. Costs and speeds remain estimates, and nullable facts
must not be presented as measured values.

OMP/provider schemas can change. Runtime claims must name pinned versions and
exercised behavior. Routing preserves role identity at the OMP overlay boundary;
source-level intent alone does not prove all upstream child-session behavior.

### Account health

Declared model quota buckets, provider-wide capacity and tier-specific windows
are different signals. Missing usage is not health or entitlement; stale,
disabled, exhausted and blocked accounts are not interchangeable. Code
interprets authorized observations and shared choices without becoming a broker
or a second account-health authority. Selected runtime pools must not broaden
when a slot disappears or changes identity.

### Native lifetime and privacy

Manifold owns grants, consent, resources, storage/migrations, native
job/terminal lifetime and traces. OMP owns broker and gateway lifetime, sign-in,
credential storage/refresh, permitted observations, workspace/probe/session
operations and ordinary agent behavior. Code owns no credential or second
account-health authority. Scoped access is not a claim that an authorized
process cannot disclose data it can legitimately read; measure containment and
refuse unavailable requirements.

Native lifetime must protect live work, uncommitted changes, child processes and
retained sessions. A missing workspace is not permission to recreate, prune or
erase it. Do not mine OMP transcript bodies or retain Code's former runtime
registry. Data adoption, broker custody and backup disposal are separate,
explicitly bounded operations.

## Promotion remains separate

Code product promotion and native OMP review are separate. Changed Code
revision/composition, OMP defaults, destination, installation, binding, service
policy or caller authority refuses stale use at its owning boundary. Building,
merging or publishing authorizes neither installation, credential movement,
broker transfer nor destructive data changes. Tags and release bytes remain
immutable. Operational evidence must identify the installed Manifold, OMP and
Code revisions, hub/surface, action, observed result and remaining boundary.
