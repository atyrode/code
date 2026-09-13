# Code's Manifold plugin

Code is TypeScript policy and React presentation inside Manifold. Manifold owns
identity, grants, consent, storage, native resources, jobs and terminals. The
independently installed `atyrode.omp` plugin owns the broker, gateway, provider
observations, workspace operations, inventory, benchmark and reviewed session
preparation. Code imports its typed caller API; it does not proxy or reimplement
those operations. The
[transition ledger](../docs/manifold-transition.md#6-transition-steps) is the
sole progress record; source descriptions here do not imply deployment.

## Family and source map

Code packs four bundles. The three visible parts require the root, and the root
declares the OMP root, accounts and gateway plugins as required dependencies.

| Directory | Plugin / surface |
| --- | --- |
| `atyrode.code/` | `atyrode.code`: shared catalog, routing, account-choice and suggestion policy |
| `atyrode.code/generator/` | `atyrode.code.generator`: workbench, catalog editor, dials, workspace/probe/session flows |
| `atyrode.code/accounts/` | `atyrode.code.accounts`: account-pool choices and OMP sign-in presentation |
| `atyrode.code/usage/` | `atyrode.code.usage`: selected-capacity and OMP usage presentation |

- `domain/contracts.ts`, `catalog.ts`, `routing.ts`, `providers.ts`: typed
  catalogs, four-level ladders, selections, estimates and the OMP overlay
  boundary.
- `domain/accounts.ts`, `usage.ts`, `probe.ts`, `suggestions.ts`: exact account
  selection, freshness and Code-owned catalog/suggestion policy over typed OMP
  observations.
- `atyrode.code/contract.ts`, `server.ts`, `state.ts`: container-scoped
  configuration actions, compare-and-set and the named schema-2-to-3 migration.
- `atyrode.code/workflow.ts`, `machine-web.ts`, `permission-plan.ts`: one
  React-free ordinary-client workflow used by both headless callers and the web.
- `service-setup.ts` and `service-policies.ts`: only Code's optional external
  `suggest` classifier policy. They do not configure OMP runtime services.
- `pack.ts`: four policy/presentation bundles. There are no Code machine
  operations, runtime artifacts, broker, gateway or probe workers.

Headless callers create `createCodeWorkflowClient(dispatch)` and supply the same
ordinary Manifold action transport as the browser. The workflow composes the
typed `atyrode.code.*` policy doors with `@atyrode/manifold-omp`; it receives
exact OMP job receipts and native terminal descriptors rather than parsing
output or spawning a Code process. `createCodeClient`, `ActionInput`,
`ActionResult`, the schemas and `actionDoor` in `contract.ts` are the smaller
policy-only boundary.

## Shared state and review boundaries

Catalogs, profiles and account-pool choices belong to the container. Schema
version 3 stores no destination runtime pins. Changing Run on preserves the
prompt, visited editors and unsaved drafts; only selected destination,
permission progress and launch review are invalidated. An installed schema
version 2 canonical record is transformed by the named native migration while
preserving revisions and choices and dropping obsolete runtime pins. A schema
version 1 machine record remains recovery data and is adopted only through an
explicit `legacyMachineId`; canonical container state always wins.

Configuration mutation is native compare-and-set. A newer shared revision keeps
a local draft visible and refuses an unreviewed save. Catalog review and
promotion remain separate from native execution. Account choices refer to exact
OMP service scopes and concrete OAuth identities or API-key slots; a changed or
missing observation refuses rather than broadening to a peer.

First-use and contextual permission review use the same typed headless plan.
Account runtime, gateway, folder creation, existing-folder validation,
inventory, benchmark and session requests are independently selectable and may
be reconsidered. Closing or declining writes nothing and does not revoke an
existing grant. Installation readiness, operation consent, caller authority and
product configuration are independent facts. A checked box, running broker or
stale retained job is never permission.

The client observes each native owner through its public door:

- `atyrode.omp.accounts` owns account/usage observations, broker review,
  credential controls and the sign-in terminal handoff.
- `atyrode.omp.gateway` owns destination gateway review and configuration.
- `atyrode.omp` owns destination readiness, workspace review/preparation,
  inventory/benchmark receipts, defaults and reviewed session preparation.
- `engine.jobs` owns exact native deployment review/progress. Code matches
  operation ids and targets; it never infers another plugin's jobs from its own
  server context.

Workspace existing maps to OMP validation and create maps to OMP creation. Both
re-observe the reviewed native pins before preparation. Inventory and benchmark
remain explicit potentially paid jobs; OMP returns their typed retained
receipts, then Code's pure policy scaffolds or derives a catalog for explicit
CAS staging. Session preparation re-composes Code policy and re-reads OMP
defaults before using the OMP review digest. Only OMP's returned destination and
runtime reach native terminal placement.

Usage polls the OMP accounts owner through the live event channel, retains the
last permitted reading while refresh is pending or refused, and labels source
age separately from quota reset time. Unknown, stale, blocked, disabled and
exhausted remain distinct. Code projects these observations through shared
account choices; it does not fetch a provider or mutate broker state.

## Pinned dependencies and gate

Use Bun 1.4.2 and two immutable revisions:

```text
<parent>/
  code/plugins/
  manifold/       exact SDK checkout selected by code/plugins/MANIFOLD_REV
```

`plugins/package.json` pins `@atyrode/manifold-omp` to one published Git commit.
`scripts/prepare-integration.ts` checks that commit out into ignored
`.integration/`, requires its `MANIFOLD_REV` to match Code's, prepares its
declared build dependencies, and invokes OMP's own staging-free packer. It
installs no daemon, credentials, service policy or machine resource.
`tsconfig.json` resolves the OMP caller API from that exact prepared snapshot.
Keep Code's `MANIFOLD_REV`, OMP's `MANIFOLD_REV` and both reusable-workflow refs
synchronized.

From the Code root:

```sh
scripts/gate.sh
```

The gate checks the Bun and SDK revisions, frozen-installs both workspaces,
prepares the real pinned OMP dependency, then runs:

```sh
bun run check
bun run test
bun run pack
bun run verify
```

`pack` compiles the complete Code family in memory before replacing `dist/`.
Output is the four `dist/<id>.manifold-plugin.json` files and `SHA256SUMS`;
runtime artifact declarations belong only to OMP. `verify` gives the generic kit
the three real pinned OMP bundles followed by Code's four bundles. Dependency
ordering installs OMP before its Code clients and uninstalls in reverse. The
browser verifier installs those same real bundles into a disposable server and
drives two ordinary identities and two permitted destinations through shared
drafts, four-level routing, permission denial and stale-review behavior. Its
native resources remain deliberately unconfigured, so it claims no provider
request, consent success or account-backed session.

The standalone OMP repository separately proves packaged workers under its
explicit native containment fixture. Code retains only consumer policy tests and
headless workflow regressions; broker shutdown/reconnect, secret redaction,
concrete-slot fallback and gateway boundaries live with their OMP owner.

## Native resources and suggestions

Native Plugins installs and reviews OMP's root, accounts and gateway bundles,
their managed artifacts, locations, service bindings and per-operation consent.
OMP's declarations are the sole truth for its Bun/SDK/pi-natives/system and
development-tool closures. Code neither duplicates those pins nor supplies a
host PATH, ambient files, credentials or a provisioning daemon.

Code's one native service policy is the optional external `suggest` classifier.
`readServiceConfiguration`, `reviewServices` and `configureServices` bind only
that service's exact revision while preserving unrelated native policies.
`suggest` invokes the reviewed `classify` operation and returns a validated
revision-bound selection; saving remains an explicit Code CAS. It does not
configure the OMP gateway or account broker.

No actual deployed revision, credential or account-backed provider proof is
supplied by this source guide. Operational acceptance must name the installed
Manifold, OMP and Code revisions, exact hub and surface, native review/action and
observed result.

## Publication and mutation authority

CI runs the plugin gate. The tag-only release workflow publishes plugin bundles
and their checksums, not standalone binaries. Published release bytes, tags and
hashes remain immutable; corrections need a new version. A release is not an
installation or machine activation. Production installation remains operator-only
from the release URL in native Plugins, never automated by this task.

Releases are artifact-only: CI installs nothing on preview or production.
The React panels use Manifold's normal in-realm renderer, not its hardened
`PanelProgram` worker renderer. The operator reviews that execution trust and
the exact bundle before installation through native Plugins, parent before
children. Machine installations, service policies and consent remain separate
explicit native actions. Source verification performs no tag or delivery.

`bun run dev -- --hub <development-hub-url> --deliver <delivery-target>` builds
and watches Code's four bundles. Install the exact pinned OMP release first;
dependency order does not grant authority or auto-install an absent external
plugin. The native loop orders Code parent before parts and reinstalls only
changed bytes. Use only an explicitly authorized development target. Reload the
browser after a successful cycle; plugin Update checks published bundles, not
working source. Restart the command after changing the development driver or
build scripts; ordinary Code source edits are picked up by the running loop.

Report Code, OMP and Manifold revisions, bundle hashes and the exercised surface
separately from merge, publication and operational acceptance. This guide grants
no release, live deployment, credential relocation, broker transfer or
destructive state change.
