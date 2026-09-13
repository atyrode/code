# Native configuration and workflows

Code is a policy and presentation plugin, not an independently configured
runtime. Manifold owns identity, storage, migrations, grants/consent, native
resources, jobs, locations and terminals. The independent `atyrode.omp` plugin
owns account and usage observations, broker/sign-in custody, gateway policy,
workspace operations, inventory, benchmark, defaults and reviewed sessions.
Code owns catalogs, selections, account-pool choices, suggestions and their
container-scoped compare-and-set. The
[architecture ledger](manifold-transition.md#6-transition-steps) records
acceptance; the [plugin guide](../plugins/README.md) covers development.

## Shared configuration

`plugins/atyrode.code/contract.ts` is authoritative. Shared state is addressed
by `{ containerId }`; a machine appears only in an execution target
`{ containerId, machineId }`. `readConfiguration` returns
`{ revision, configuration, legacyMachineId }`, with revision `0` when absent.
Schema version 3 contains:

- a positive monotonically increasing `revision`, `updatedBy` and `updatedAt`;
- shared `accounts` choices and presets;
- nullable `draft` and `active` catalog documents with their digests;
- a nullable shared `selection`.

It contains no machine resources, native pins, job state, broker metadata or
credentials. The root declares data version 2.0 and a real named native
`canonical-configuration-v3` migration. It transforms only canonical schema
version 2 records, preserving revisions and choices while dropping the retired
machine-pin map. Schema version 1 machine records remain untouched recovery
data. A caller can adopt one only by naming `legacyMachineId` while canonical
state is absent; the first mutation creates canonical version 3 through normal
CAS. Code never scans, ranks, merges or fans out legacy records.

Container read/write authority is checked at every action. Native
`ctx.storage.compareAndSet` commits the exact previous bytes, so concurrent
edits refuse with `code_stale_preferences`. `preferences_changed` invalidates
observations. A local React draft stays visible after a remote edit but is not
an authoritative store.

## Code policy doors

All Code actions are `atyrode.code.<name>`:

| Purpose | Actions |
| --- | --- |
| Configuration | `readConfiguration`, `initializeConfiguration`, `select`, `changeAccounts` |
| Catalog authoring | `stageCatalog`, `reviewCatalog`, `promoteCatalog` |
| Pure OMP input policy | `composeProbe`, `draftInventory`, `deriveCatalog`, `composeSession` |
| External classifier | `readServiceConfiguration`, `reviewServices`, `configureServices`, `suggest` |

`initializeConfiguration`, `stageCatalog`, `promoteCatalog`, `select` and
`changeAccounts` take `expectedRevision`. A catalog review takes
`{ containerId, expectedRevision, source: "active" | "draft" }` and returns the
exact catalog digest, compiled route/estimate review and `reviewDigest`.
Promotion supplies that digest against the same source and revision.

`CatalogDocumentSchema` is `{ schemaVersion: 1, models: [...] }`. Each model has
an explicit key, provider/id/API identity, tier, quota bucket, costs,
performance, context, thinking levels and image support. Tier 0 is off-ladder;
capabilities are 1–4. `SelectionSchema` records lane, capability, thinking,
advisor, spark, priority, prewalk, plan-yolo and fallback. Code never recovers
these semantics from terminal output.

The pure composition doors consume caller-supplied values already parsed by the
OMP client schemas. `composeProbe` turns a concrete current account observation
into Code's selected runtime pool. `draftInventory` and `deriveCatalog` convert
typed OMP receipts into ordinary unpromoted catalog data. `composeSession`
combines the saved catalog/selection, a current OMP account observation and the
prompt into the exact account pool, OMP overlay, plan-yolo value and a digest
binding those choices to the Code revision. These doors neither attest the
observation nor invoke native execution; OMP independently validates concrete
accounts and native revisions before running.

`readServiceConfiguration`, `reviewServices` and `configureServices` manage
only Code's optional external `suggest` classifier. Review takes an explicit
`classifier: { origin, model } | null` and the exact native service revision;
configuration requires its digest and preserves unrelated service policies.
`suggest` also binds `expectedServiceRevision`, validates the classifier result
and returns an unsaved selection plus changed fields. None of these actions
configures the OMP gateway or broker.

## Ordinary Code/OMP workflow

`createCodeWorkflowClient(dispatch)` is React-free and uses the same ordinary
Manifold action transport as the web. It composes `createCodeClient` with
`createOmpClient`; no Code server proxies an OMP action. Important flows are:

- **Permission review:** read OMP root destination readiness, account-owner
  setup/observations and gateway-owner setup independently. Build exact native
  deployment requests per selected feature. A checked choice is intent only.
  Closing or declining writes nothing. A destination/defaults/authority change
  invalidates outstanding review without erasing drafts or prompts.
- **Runtime configuration:** account runtime review/apply stays owner-only under
  `atyrode.omp.accounts`; gateway review/apply stays owner-only under
  `atyrode.omp.gateway`. Ordinary ready account observations do not require the
  caller to hold setup authority.
- **Workspace:** `"existing"` maps to OMP validation and `"create"` to OMP
  creation. The client obtains OMP's review, re-reads destination readiness and
  exact pins, then prepares the reviewed job. It never falls back from failed
  validation to creation.
- **Inventory and benchmark:** read OMP defaults and accounts, compose the Code
  pool, start OMP's job, then read OMP's typed retained receipt. Benchmark binds
  the inventory job; derived catalog data is staged only through a later
  explicit Code CAS.
- **Session:** compose Code policy and read OMP defaults, request OMP's native
  review, then re-compose/re-read before prepare. Changed Code digest or defaults
  revision refuses. Only OMP's returned destination, review digest and
  `TerminalRuntimeSchema` reach `host.authoring.createTerminal`.
- **Sign-in and usage:** OMP accounts owns setup, terminal placement and current
  observations. Code projects usage through shared account choices. The web
  polls on the live owner event channel, retains the last permitted reading
  while a refresh is pending or refused and labels source age separately from a
  quota reset.

Workspace, inventory and benchmark results are OMP-owned native job records.
Code accepts only exact OMP plugin/operation/machine/job identities when reading
retained status. It never lists jobs through its own server context or treats
admission as successful execution.

## Accounts and custody

Account references distinguish OAuth identity from concrete credential slot and
include the OMP broker service scope. `changeAccounts` edits the active manual
set or a named preset. Selection against an unavailable, stale or changed
observation refuses rather than broadening to another account. Unknown,
stale, blocked, disabled and exhausted remain different states; a fresh native
quota verdict takes precedence over a rounded fraction.

OMP's accounts action door owns `accounts`, `usage`, `clearAccountBlocks`,
`disableCredential`, `readAccountSetup`, `reviewAccountRuntime`,
`promoteAccountRuntime` and `prepareSignIn`. Gateway ownership similarly remains
under OMP's gateway door. Code receives no credential input, service bearer,
provider error body or raw broker snapshot.

A move from an older Code-owned broker changes the service scope by design.
Operational cutover must first prove the same concrete provider, credential id
and identity slots under the new OMP owner, then update saved choices through
revision-checked `changeAccounts`; it must not add a compatibility alias or
match ambiguous email. Credential bytes and protected backups are not part of
Code configuration.

## Native installation and evidence

OMP's manifests are the sole declarations for managed Bun/SDK/pi-natives
artifacts, the independently reviewed system/development closures, service and
location bindings, and operation consent. Code packs no machine half and owns no
runtime artifacts. Native Plugins must install and review OMP root, accounts and
gateway separately; dependency declarations order supplied bundles but do not
auto-install, enable or grant anything.

`plugins/package.json` pins the typed OMP client to one immutable Git commit.
`scripts/prepare-integration.ts` checks out that exact OMP source, requires its
Manifold SDK pin to equal Code's, prepares OMP's declared build inputs and runs
OMP's own packer. `scripts/gate.sh` then typechecks/tests/packs Code and verifies
the three real OMP bundles plus Code's four bundles on a disposable server and
in real browsers. The fixture deliberately has no native resource or credential
configuration, so it proves composition/refusal and UI behavior, not provider
success.

Babel may consume the headless boundary independently; Code does not depend on
Babel or retain an old process ABI for it. Source, merge, CI, release,
installation, native consent, provider response and custody transfer are
separate evidence. The historical five-Code-bundle preview predates the OMP
owner and does not certify this cutover. Production changes, credential
relocation, broker transfer and backup disposal require separate authorization.
