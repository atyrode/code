# Native configuration and workflows

Code is a Manifold plugin, not an independently configured process. Manifold
owns storage, credential-source references, service policy, grants/consent,
resource revisions, jobs, locations and terminals. Code owns typed product
schemas and governed actions. OMP owns ordinary agent execution and sessions.
The [architecture ledger](manifold-transition.md#6-transition-steps) records
acceptance; the [plugin guide](../plugins/README.md) covers development.

## Shared configuration

The authoritative schema is `plugins/atyrode.code/contract.ts`. A target is
`{ containerId, machineId }`, using native identities, not a label or host path.
`readConfiguration` returns `{ revision, configuration }`; absent state has
revision `0`. `initializeConfiguration` takes the target and `expectedRevision`.
The resulting configuration contains:

- a monotonically increasing `revision`, `updatedBy` and `updatedAt`;
- shared `accounts` choices and presets;
- nullable `draft` and `active` catalog documents with digests;
- nullable `selection` and promoted `resources`.

`state.ts` stores one record for each target through native plugin storage.
Container scope and read/write grants are checked at the action boundary;
`ctx.storage.compareAndSet` atomically commits the exact previous value.
Concurrent edits refuse with `code_stale_preferences`, not last-writer-wins.
`preferences_changed` invalidates observations so clients reread current state.
Local React editor drafts are not another authoritative store.

## Catalog, dials and reviews

`CatalogDocumentSchema` in `plugins/domain/contracts.ts` is
`{ schemaVersion: 1, models: [...] }`. Each model has explicit `key`, `provider`,
`id`, `api`, `tier`, `quotaBucket`, costs, performance/context measurements,
`thinkingLevels` and `images`. Tier `0` is off-ladder; capabilities are `1`–`4`.
Nullable metrics mean unknown. Typed validation and `compileCatalog` enforce
catalog invariants; no terminal-format parser or legacy catalog file is involved.

In the launcher, edit a candidate directly or import typed JSON into the local
editor. Import is not a commit. `stageCatalog` validates and stores a draft;
`reviewCatalog` with `source: "draft"` or `"active"` returns routes, estimates,
resource observations and a `reviewDigest`. `promoteCatalog` requires the exact
`expectedRevision`, source and review digest. Promotion commits the reviewed
catalog, selection and resource snapshot, clearing the promoted draft.

`SelectionSchema` contains `lane`, `capability`, `thinking`, `advisor`, `spark`,
`priority`, `prewalk`, `planYolo` and `fallback`. Save via `select` with an
`expectedRevision`. Routing and estimates are typed domain computations; only
the final OMP boundary produces its overlay/arguments. Disabling model fallback
does not disable same-model retries or redefine broker account policy.

Catalog editing/review and shared preferences do not start machine jobs and
can remain useful while execution is unavailable. Resource observations in a
review are not a readiness claim. A changed product bundle, state, service
policy or execution binding requires renewed review where the action binds it.

## Native resources, services and consent

`readSetup` reports native execution installation/operation readiness, services
and connectivity. Use native Plugins for artifact installation, resource and
location bindings, operation consent and retained job lifecycle. In Code,
`reviewResources` followed by `promoteResources` adopts the exact reviewed
snapshot for a configuration, including before a catalog exists.

Promoted resources contain `productSha256`, nullable `execution` with
`installationRevision`, `artifactSha256` and per-operation binding digests,
and service pins with `serviceId`, `revision` and `policySha256`. Promotion does
not install artifacts, grant consent or make unavailable operations ready.

Managed Bun 1.4.2, OMP/SDK 18.1.14 and pi-natives artifacts are pinned in
`plugins/runtime-artifacts.json`; `workers/build.ts` supplies the declarations
at pack time. Every machine operation requires `runtimeTools.system`: the
native owner's independently reviewed/promoted interpreter and transitive
library closure. The direct-ELF requirements report is not that closure.
Missing resources refuse admission; PATH, host files and incidental caches
are not substitutes.

### Owner-held credential references

The native service setup UI uses `readServiceConfiguration`, `reviewServices`
and `configureServices`. This requires the root owner's current
`services:configure` machine authority and applicable container access. Inputs
select an exact broker origin and existing `credentialRef`, optional classifier
origin/model, and API-key `{ provider, credentialRef }` selections. A source
must be available for the exact broker origin. No secret value is accepted.
Review includes `expectedServiceRevision`; configuration requires the returned
`reviewDigest` and native compare-and-set semantics. Unrelated native service
policies are preserved.

First configure the broker (and optional classifier/API-key operations). If no
ready gateway exists, the review explicitly omits `omp`. In native Plugins,
review/install `atyrode.code.gateway` with its broker/system bindings and approve
the required operation consents. Review service setup again to bind `omp` to
that gateway's exact installation/artifact/operation revision. Then review/install
`atyrode.code` with its current service/system/location bindings and explicitly
approve the bounded caller-to-gateway invocation edges. These are native
installation and authority changes, not automatic effects of opening Code.

Policies define the `broker`, optional `suggest`, and `omp` scoped services.
Manifold owns resolution, grants, consent and revision enforcement. Upstream
secrets stay with the machine-side native resolver. Job-local scoped service
URLs/bearers are injected into declared sealed input files, not exposed as
upstream credentials in browser inputs, hub records, argv, logs or job results.
Read, mutation and runtime operations have distinct authority.

This UI does not create credential sources, deploy a broker or provision a
system closure. If the owner has not supplied the required resource, it is
unavailable. There is no Code provisioning daemon or credential-import recipe.

## Accounts, usage and onboarding

`accounts` returns permitted metadata with native service scope.
`changeAccounts` commits revision-checked choices: `set-account`,
`create-preset`, `update-preset`, `activate-preset` or `delete-preset`.
References distinguish OAuth identities (`kind: "identity"`) from native
credential slots (`kind: "credential"`); a launch freezes concrete slots and
observed identities rather than an open-ended provider pool.

`usage` combines permitted service observations with shared choices and freshness.
Unavailable, stale, disabled, blocked and exhausted are distinct states.
`clearAccountBlocks` and `disableCredential` are separately governed service
mutations, not ordinary preference edits.

**API keys:** the owner first selects an existing native source reference for a
provider in reviewed service setup. `enrollApiKey` then takes only the target and
`provider`; it invokes that policy's `enroll-key-<provider>` operation with empty
input. A caller cannot supply a key, choose another source or override transport.
Supported provider IDs come from the pinned SDK metadata. A supported schema or
admitted operation does not establish that an upstream key was accepted.

**OAuth:** `observeEnrollment` reports supported flows, exact pins, availability
and native job state. `startEnrollment` binds a machine/provider and those pins;
`respondEnrollment` handles a correlated callback; `cancelEnrollment` ends the
native enrollment lifetime. The pinned SDK worker performs a fresh grant and
uploads through its scoped broker operation. Existing login files or sessions
are not imported. Authentication remains unavailable without the required
machine resources, authority and consent. This reference contains no instruction
to use live accounts or credentials to establish acceptance.

## Inventory, benchmarks and suggestions

- `startInventory` creates a native `atyrode.code.catalog-inventory` job against
  promoted resources and selected accounts. `inventory` reads its retained
  typed receipt and unpromoted draft.
- `startBenchmark` binds an `inventoryJobId` and creates a native
  `atyrode.code.catalog-benchmark` job. `benchmark` reads its receipt/catalog;
  `stageBenchmark` stages that exact result against an `expectedRevision`.
  Catalog review and promotion remain separate.
- These explicit jobs contact providers and may incur cost. Native job IDs,
  output access, cancellation and history remain Manifold-owned. Admission is
  not successful execution; unavailable/inconclusive observations are not proof.
- `suggest` uses the promoted `suggest` service's `classify` operation and
  validates its response. It returns a revision-bound selection without saving
  it. Apply as a local draft, inspect it, then commit through `select`.

## Launch and workspace boundary

`previewLaunch` returns exact routes, selected account slots, resource pins and
a `previewDigest`. `prepareLaunch` takes that digest, `expectedRevision` and a
prompt, rechecks the reviewed inputs and returns `{ runtime }` conforming to
Manifold's `TerminalRuntimeSchema`. It does **not** start a terminal. The web
panel passes that runtime to `host.authoring.createTerminal` so the mounted native
renderer creates the canvas portal or composition tile. Native terminal admission
governs execution; a returned placement is not OMP readiness.

The manifest declares `atyrode.code.workspace` and `atyrode.code.sessions`
locations for the launch working directory and OMP sessions. These are governed
location bindings, not arbitrary client paths. On first use, `prepareWorkspace`
with the current `expectedRevision` starts a native job that creates those
locations and runs the pinned OMP version probe. Inspect its completed native
result before launch. Creation refuses existing locations; it does not replace
or import user data. Launch uses separately consented write access, so later
sessions reuse the locations rather than trying to create them again.

Preparation does not clone a repository or introduce a private workspace/session
registry. Native location and terminal lifecycle and OMP's own in-session
isolation remain their owners' responsibilities. Existing user data must not be
moved or deleted by inference.

## Headless clients and evidence

All product actions are `atyrode.code.<name>` through Manifold's governed action
API. `ActionInput`, `ActionResult` and `actionSchemas` in `contract.ts`, plus the
enrollment schemas in `auth-contract.ts`, define the exact boundary. Web and
agent clients use the same authority and state; no printed-output protocol is
required. Babel depends on Code, not vice versa. Its native adoption is separate
and not claimed here; preserving an old engine ABI is not a Code prerequisite.

The current integration source is not a statement about main. The shared
preview's exact deployment and bounded live observations are recorded in
[status](status.md#source-is-not-deployment); they do not certify every workflow.
Production deployment, releases, credential relocation, broker retirement and
destructive state changes require separate authorization.
