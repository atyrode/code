# Status and caveats

Code is `atyrode.code`, a TypeScript/React/Bun plugin within Manifold, using OMP
for agent execution. [#149](https://github.com/atyrode/code/issues/149) records
the ratified replacement; [#102](https://github.com/atyrode/code/issues/102)
owns integration. The [architecture's section 6](manifold-transition.md#6-transition-steps)
is the sole transition ledger. This page records constraints, not another roadmap.

## Source is not deployment

The current integration source contains typed domain modules, five plugin
bundles, React launcher/accounts/usage panels, governed catalog/preferences/
account/service actions, and Bun probe/broker/gateway workers. OMP owns sign-in,
credential storage and refresh through its pinned terminal and shared broker.
Code uses native storage CAS, resource and service revision pins, jobs and terminal runtime
contracts. This corrects the earlier bootstrap-only and Go-worker source
description; it does **not** claim the integration has merged on main.

The source cutover removes standalone product/toolchain/state-format dependencies.
Historical prototype checks under draft #148 apply to that historical tree,
not automatically to this replacement. Current gate, browser and machine
results must identify the actual Code/Manifold revisions and exercised paths.
On 2026-09-09, all five Code bundles were installed on
<https://preview.manifold.tyrode.dev> with Manifold
`abcbc62187a10c8d4f19e50352a30d0b8033a2c4`. The parent Code bundle is
`35fc87e5775df0b034e91258b47bd5ada89f8e20beb796013fefc2eb9a65aaa0`.
Both local gates and the native revision's required CI passed.

Live checks used temporary agent principals and a separately owned native
machine to read projected broker account metadata, prepare OMP 18.1.14, inventory
36 models, and generate and promote an unmeasured catalog. Native terminals
started in both canvas and composition containers without the setup wizard;
the launch jobs retained their original requester and exact installation revision.
Credentials remained behind their existing protected owner-held references.
These observations do not yet prove fresh provider enrollment, an account-backed
OMP response or browser workflow acceptance.

See [plugin development](../plugins/README.md) for the Bun 1.4.2 gate and
[configuration](configuration.md) for current native workflows. There is no
legacy CLI, Nix product, environment-variable setup or private-state migration
requirement. Existing user files and live resources are not altered by a source
retirement decision.

## Explicit availability boundaries

- Managed Bun, OMP and pi-natives pins do not supply the native owner's
  independently reviewed `runtimeTools.system` closure. The requirements report
  lists direct ELF dependencies; a missing transitive closure, binding, consent,
  service grant or machine connection must remain unavailable.
- Instance sign-in selects the declared native broker owner. `readAccountSetup`
  observes its state; `prepareSignIn` creates or reuses the broker at exact native
  revisions and hands off the pinned OMP terminal on that owner. No owner
  discovery/failover or private Code authentication form is involved. Authorized
  machines share the broker; Code observes only permitted account metadata.
- Per-machine service setup reviews and commits the exact native gateway and
  optional classifier policies, preserving unrelated policies. It does not set
  up instance authentication, accept credentials or provision infrastructure.
  Neither an exposed sign-in flow nor a successful synthetic fixture proves
  live provider enrollment, an account-backed response or current shared-preview
  browser acceptance. The dated deployment above is not evidence for this source
  cutover.
- Pure catalog/preferences operations need no machine process or selected
  accounts. A catalog review can record unavailable execution resources without
  certifying them. Runtime preview/launch requires current promoted resources
  and exact selected accounts.
- `prepareLaunch` returns a reviewed runtime; native terminal creation/admission
  and actual OMP readiness are different observations. Verify process output,
  cancellation and reconnect before claiming those behaviors.
- Workspace preparation is a native create operation plus the pinned OMP version
  probe. It refuses existing locations; launches reuse them with write consent.
  This is not repository cloning, a private registry or a preparation daemon.
- Code's typed native headless contract is available for downstream clients.
  Babel is a consumer, not a Code dependency or acceptance prerequisite. This
  task neither changes Babel nor claims its native adoption, and does not keep
  an obsolete process ABI for it.

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

Manifold owns grants, consent, resources, persistence, job/terminal lifetime and
traces, including instance broker placement and lifetime. OMP owns sign-in,
credential storage and refresh, ordinary model retries/fallback, quotas, resume
and in-session subagent isolation. Credentials remain in OMP's owner-local store;
native service policy projects permitted metadata for Code and separately governs
gateway access. Scoped access is not a claim that an authorized process cannot
disclose data it can read. Declare measured containment only and refuse
unavailable requirements.

Native lifecycle must protect live work, uncommitted changes, child processes
and retained sessions. A missing workspace is not permission to recreate,
prune or erase it. Do not mine OMP transcript bodies or retain Code's former
private registry to simulate lifecycle ownership. User data adoption or cleanup
requires an explicit bounded authorization.

## Promotion remains separate

Promotion explicitly selects exact reviewed product/configuration/execution
and service revisions. A changed revision refuses stale use; live observation
freshness and equivalent secret rotation have their own semantics. Building,
merging or publishing authorizes neither deployment nor credential relocation,
broker retirement or destructive data changes. Tags and release bytes remain
immutable. Operational evidence must identify the actual installed revision,
hub/surface, action, observed result and remaining boundary.
