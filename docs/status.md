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
- The first workbench derives a frozen local starter from OMP's passive bundled
  SDK model metadata after a successful absent or initialized-empty configuration
  read. The generator's rows and routing need no account or runtime setup. The
  starter is render-only: saving it is the model verification (OMP inventory
  through the saved account pool, a charge the operator confirms, per-provider
  benchmarks, then the derived catalog staged, reviewed, promoted and saved with
  the selection). Stored active policy wins and unrecorded historical provenance
  stays unknown. Read-only native panels remain locally explorable, not writable.
  Disposable presentation/CAS proof is not native consent, configured accounts,
  provider execution, a release or authenticated preview acceptance.
- Agent launch through Code reaches Manifold's real doors only up to `launchRun`. The
  gate's browser verifier presses the launch as a human sponsor with `agents:delegate`
  on its disposable server: Code registers its Agent and creates a Run, the machine
  (no native job owner) refuses `launchRun`, Code cancels the Run (`listRunsV2` reads
  it cancelled) and the launch line says the refusal. Without the harness operation
  the press is the reviewed session. Sessions' Runs (activity, the lease to 24 of 24
  and detached, the dials' pending, confirmed, clamped, not served, unanswered and
  forbidden states) are rendered from fixtures shaped on that real Agent and Run, with
  a synthetic `controlRun`. No launched Run, renewal, activity report or `controlRun`
  answer has been exercised through Code or on any preview; those are proven end to
  end only by OMP's own native harness gate. The launch line after a launch
  ("Launched on … · dials", or "· no live dials: …" with **Enable in Setup**) needs an
  opened terminal, which the disposable server cannot open, so only unit tests cover
  it. Code shows only the last
  `controlRun` answer this browser received, else the launch's model, because
  `Run.model` is written once (atyrode/manifold#1071). A Run is attributed for at
  most about 13 leases. After that, or after a missed renewal, its TUI goes on
  detached and unattributed, with no dials.
- The main view's presentation has these bounds. Cost is a relative list-price index,
  not billing, and the speed meter stays unlit and says "unmeasured" until every lead
  model has measured throughput. The usage pane reads again every five minutes
  (Code's own cadence, since the host's feeds read again only on events while their
  channel is live); it draws reported windows, balances and blocks, not reset credits,
  which appear in the manage view's readings. The accounts view only switches
  accounts; the pool, presets, sign-in and credential actions are in Manage accounts,
  which keeps the Code accounts panel's own controls. Spark is retired: models that
  draw a quota of their own are left off the ladder, a stored Spark flag reads as off
  and no control, route or usage bucket exists for it. A machine on which OMP is not
  installed is never a default destination and is refused in the machine list; where OMP answers is
  read for every online machine and says nothing about its permissions or accounts.
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
- The credential runtime uses OMP's published 18.8.6 graph with its retained
  patch; the ordinary CLI and the independent, unpatched SDK host use 18.8.6 too.
  Native lifecycle accounting uses public SDK hooks and passes the retained
  deadline/quiescence regressions without copying credential algorithms. This
  does not qualify the separate unpatched credential migration in
  [manifold-omp#72](https://github.com/atyrode/manifold-omp/issues/72).
  Code's existing-Run tools and one-shot sessions were qualified against OMP
  [`f67e4f1`](https://github.com/atyrode/manifold-omp/commit/f67e4f14fd0835d51ce0c5d54adeb8c43ec369f9)
  ([manifold-omp#98](https://github.com/atyrode/manifold-omp/pull/98), merged) and
  Manifold [`0701320`](https://github.com/atyrode/manifold/commit/070132088e30f10266e43a52074bc58f16c051fe).
  The pinned [worker build](https://github.com/atyrode/manifold-omp/blob/f67e4f14fd0835d51ce0c5d54adeb8c43ec369f9/plugins/workers/build.ts#L497-L508)
  retains whitespace compaction without syntax or identifier minification.
  Its [native gate](https://github.com/atyrode/manifold-omp/actions/runs/36666167090)
  passed with complete-family fingerprints matching local builds. This conservative
  configuration does not identify the original compiler cause;
  [manifold-omp#94](https://github.com/atyrode/manifold-omp/issues/94) retains that
  investigation. Matching bytes do not authorize replacing an enabled native
  declaration; downstream release verification and deployment review remain separate.
  OMP's [one-shot run location](https://github.com/atyrode/manifold-omp/blob/f67e4f14fd0835d51ce0c5d54adeb8c43ec369f9/plugins/atyrode.omp/manifest.json#L1528-L1537)
  uses temporary raw output directories; sealed transcripts remain readable, while
  workspace/session state and legacy directories are unchanged. Code retains its
  panel-free baseline web registration for the shared stylesheet and declares the
  portable Worker entry that the pinned SDK requires for hardened installation.
  The gate runs real Code-to-native tool and bounded-material proof against Code's
  current pins. Source and disposable verification do not establish a released Code bundle
  or deployed production capability, and no transition-ledger row advances.
  Code now pins Manifold
  [`cd75fbb`](https://github.com/atyrode/manifold/commit/cd75fbba6d4601fee14267f17e1594429ae17bc3),
  protocol 57, and OMP
  [`9fdbed9`](https://github.com/atyrode/manifold-omp/commit/9fdbed9906e3a87172b873064c0b3422cb4e2b45)
  ([manifold-omp#120](https://github.com/atyrode/manifold-omp/pull/120)), whose own
  `MANIFOLD_REV` is the same commit. A protocol 57 hub admits only bundles stamped 57
  ([manifold#1068](https://github.com/atyrode/manifold/issues/1068)), so Code's four
  bundles and OMP's three are rebuilt on that SDK and no earlier stamp is retained.
  These pins add OMP's TUI Agent harness and `atyrode.omp.controlRun`
  ([manifold-omp#116](https://github.com/atyrode/manifold-omp/pull/116)) and Manifold's
  pending-Run lifecycle doors ([manifold#1072](https://github.com/atyrode/manifold/pull/1072));
  Code calls neither and launches no Agent.
  The OMP pin also scopes accounts by custody of the broker's credential store
  ([manifold-omp#121](https://github.com/atyrode/manifold-omp/pull/121)); the one
  scope change its adoption causes is described under
  [Accounts and custody](configuration.md#accounts-and-custody). Its gateway names a
  provider's definite refusal of a model, which a benchmark settles as `not_found` or
  `client_blocked` rather than `unresolved`
  ([manifold-omp#122](https://github.com/atyrode/manifold-omp/pull/122)). Its native
  proof refuses unless the family it re-packs inside its unit reproduces the
  `SHA256SUMS` of the family under verification
  ([manifold-omp#119](https://github.com/atyrode/manifold-omp/pull/119)); Code's
  `verify:native` names the sums of the OMP bundles its gate prepared and installed.
  OMP's inventory receipt is now its 18.8.6 one, and each row carries the SDK's
  `quotaTier`, which the derivation reads directly. OMP's bundled catalog is stamped
  with its separately pinned SDK's version, now also 18.8.6. No version string decides
  whether a verification holds: it records the artifact its inventory ran from and the bundled
  catalog's revision, and goes stale when the destination pins another artifact or OMP
  bundles another revision, with no Code rebuild. A verification recorded before this
  change, without those identities, reads as unverified and asks to be verified again,
  and a current one can be renewed on purpose. Unit tests and the disposable browser
  prove this against a synthetic destination and the real bundled catalog; no
  installed OMP upgrade has been observed. This source repin is not a release, preview
  installation, native deployment review or provider observation.
  The one-shot-only `agentTools: { runId }` selector carries existing native
  authority; it does not grant, infer or acknowledge it. Omission stays unbound.
  Read, follow and cancel preserve the exact retained Run correlation.
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
