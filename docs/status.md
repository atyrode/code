# Status and caveats

Code is `atyrode.code`, a TypeScript/React policy and presentation plugin within
Manifold. The independent
[`atyrode.omp`](https://github.com/atyrode/manifold-omp) plugin owns its native
runtime. [#149](https://github.com/atyrode/code/issues/149) records the ratified
replacement and [#161](https://github.com/atyrode/code/issues/161) its current
cross-repository integration. The
[architecture's section 6](manifold-transition.md#6-transition-steps) is the sole
transition ledger. This page records constraints, not another roadmap.

## Source is not deployment

Current integration source contains four Code bundles: container-CAS
catalog/routing/account-choice/suggestion policy and the launcher/accounts/usage
React surfaces. It imports the typed OMP caller package and has no machine
manifest, broker, gateway, probe workers or runtime artifact pins. The shared
headless workflow calls OMP's public owner-scoped actions through ordinary
Manifold dispatch, rechecking Code composition, OMP defaults, destinations and
native review pins before effects.

This is not yet a claim that the integration has merged or replaced the preview
runtime. Local evidence must name the exact revisions and path. The current
source gate prepares three real OMP bundles, verifies them with Code's four
bundles on a disposable server, and drives two real browsers; because the
fixture has no native resources or credentials, it proves composition,
container-shared state, UI behavior and refusal boundaries, not consent success
or an account-backed response. OMP's separate packaged verification exercises
its real workers under explicit disposable native containment without providers
or existing credentials.

The 2026-09-09 preview installation was five Code-owned bundles at an older
Manifold revision. Its broker metadata, inventory and terminal observations
predate the independent OMP owner and do not certify this source cutover. The
current live broker was restored through existing native authority without
moving credentials; it remains under its existing custody until the explicit
preview transfer sequence passes every acceptance criterion.

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
