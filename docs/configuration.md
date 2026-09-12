# Native configuration and workflows

Code is a Manifold plugin, not an independently configured process. Manifold
owns storage, credential-source references, service policy, grants/consent,
resource revisions, jobs, locations and terminals. Code owns typed product
schemas and governed actions. OMP owns provider sign-in, credential storage and
refresh, ordinary agent execution and sessions.
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

Catalog editing/review and shared preferences do not start machine jobs or require
selected accounts, and can remain useful while execution is unavailable. Resource
observations in a review are not a readiness claim. A changed product bundle,
state, service policy or execution binding requires renewed review where the
action binds it.

## Native resources, services and consent

`readSetup` reports native execution installation/operation readiness, services
(including the configured instance broker) and connectivity. Native Plugins owns
artifact installation, resource/location bindings, operation consent and retained
job lifecycle. In Code,
`reviewResources` followed by `promoteResources` adopts the exact reviewed
snapshot for a configuration, including before a catalog exists.

Account sign-in and one-time machine setup are separate. The launcher first
guides you through the model connection: review the gateway software and access
in Native Plugins, return to Code, then review and use that connection. Once it
is ready, Code presents folder, model-discovery and session permissions as the
next step. Readiness updates automatically; advanced permissions remain available
for troubleshooting. Reviewing setup does not move credentials or start a model
request, and paid benchmarks keep their separate approval.

Promoted resources contain `productSha256`, nullable `execution` with
`installationRevision`, `artifactSha256` and per-operation binding digests,
and service pins with `serviceId`, `revision` and `policySha256`. Promotion does
not install artifacts, grant consent or make unavailable operations ready.
The UI checks resource readiness and exact enabled native consent separately.
Setup needs one workspace route plus inventory and launch permissions; retained
workspace and inventory results also require their status-read consent. A classifier
authorized only for invocation remains discoverable without granting service-read authority.

Managed Bun 1.4.2, OMP/SDK 18.1.14 and pi-natives artifacts are pinned in
`plugins/runtime-artifacts.json`; `workers/build.ts` supplies the declarations
at pack time. Every machine operation requires `runtimeTools.system`: the
native owner's independently reviewed/promoted interpreter and transitive
library closure. The direct-ELF requirements report is not that closure.
Missing resources refuse admission; PATH, host files and incidental caches
are not substitutes.

Ordinary launch additionally requires the reviewed `development` runtime-tool
group and managed Bun. Its explicit entrypoints provide `/bin/sh`, Bash and
coding commands on `/usr/bin`, including Git and Python 3.10+. OMP's bundled
Python runner requires no Jupyter or additional pip packages.
Declare their complete package closures, not a host PATH or all of `/nix/store`.
The NixOS profile supports this through `execution.runtimeToolClosures` alongside
the existing `runtimeTools` entrypoints. Missing development resources block
launch rather than opening an incomplete terminal; account sign-in and service
workers retain their narrower resources.

The `system` group also provides the reviewed public resolver at
`/etc/resolv.conf` and CA bundle at `/etc/ssl/certs/ca-certificates.crt`.
Native operations declare the corresponding `SSL_CERT_FILE`; ordinary launch
also declares `GIT_SSL_CAINFO`. These are explicit in-job resources, not a host
`/etc` mount or inherited environment.

### Machine execution-service setup

The root actions `readServiceConfiguration`, `reviewServices` and
`configureServices` manage per-machine execution services, not instance
authentication. Read/review require native owner authority and authorized target
access; configuration also requires root `services:configure` machine authority
and a writable target.

- `readServiceConfiguration` takes the target and returns the native
  `ServiceConfigurationReadSchema`.
- `reviewServices` takes the target, `expectedServiceRevision: string | null`
  and optional `classifier: { origin, model } | null`. It returns
  `{ expectedServiceRevision, policies, reviewDigest }`.
- `configureServices` takes those same inputs plus the exact `reviewDigest`
  and returns the native `ServiceConfigurationSchema`.

Omitting `classifier` preserves the existing `suggest` policy; `null` explicitly
removes it, and a value sets its origin/model. Review and configuration derive
the current ready `atyrode.code.gateway.serve` installation, artifact and
operation binding pins themselves, with `accountPool: { input: "accountPool" }`.
Callers cannot override runtime pins or supply credentials. The exact native
configuration revision and reviewed candidate digest must still match at commit;
changed configuration or gateway resources require a fresh review. Every unrelated
native machine policy, including any broker policy, is preserved.

In native Plugins, review/install `atyrode.code.gateway` with its instance
accounts-broker/system bindings and approve the required operation consents.
Then review/configure the machine's `omp` service and optional `suggest`
classifier. A missing or unready gateway refuses setup rather than silently
omitting `omp`. Review/install `atyrode.code` with its current service/system/
location bindings and explicitly approve the bounded caller-to-gateway
invocation edges. These are native installation and authority changes, not
automatic effects of opening Code.

Manifold owns resolution, grants, consent and revision enforcement. OMP's
instance broker remains independently owned and configured as described below.
Job-local scoped service URLs/bearers are injected into declared sealed input
files, not exposed as upstream credentials in browser inputs, hub records, argv,
logs or job results. Read, mutation and runtime operations have distinct authority.
Execution-service setup does not acquire credentials, configure the shared
broker, install artifacts or provision a system closure. Unavailable resources
stay unavailable; there is no Code provisioning daemon or credential-import recipe.

## Accounts, usage and onboarding

`accounts` returns permitted metadata from the native instance broker.
`changeAccounts` commits revision-checked choices: `set-account`,
`create-preset`, `update-preset`, `activate-preset` or `delete-preset`.
References distinguish OAuth identities (`kind: "identity"`) from native
credential slots (`kind: "credential"`); a launch freezes concrete slots and
observed identities rather than an open-ended provider pool.

`usage` combines permitted service observations with shared choices and freshness.
Unavailable, stale, disabled, blocked and exhausted are distinct states. A fresh
explicit provider quota verdict takes precedence over a rounded usage fraction:
100% reported as still allowed does not become exhausted.
`clearAccountBlocks` and `disableCredential` require the confirmed `reference`
and positive `credentialId` alongside the target. If the same OAuth identity has
moved to a replacement slot, the stale confirmation refuses without mutating it.
These are separately governed service mutations, not ordinary preference edits.

**OMP-owned sign-in:** the accounts plugin exposes
`atyrode.code.accounts.readAccountSetup` with `{}` input. It returns the native
broker `revision`, declared `owner`, `state`, `canSignIn` and `reason`. The
configured instance owner is authoritative; before configuration, the native
default owner is used. Neither workspace machine selection nor filesystem or
network discovery can choose another owner, and an offline owner has no failover.

`atyrode.code.accounts.prepareSignIn` takes
`{ containerId, expectedBrokerRevision: string | null }` and returns
`{ machineId, runtime }`. It requires writable container access and the root
owner's native `services:configure` authority. It creates or reuses the instance
`atyrode.code.accounts.broker` service on that declared owner, checking the exact
native broker revision and current ready accounts installation/artifact/operation
binding pins. Reuse must match the current policy; stale or unavailable resources
refuse rather than silently adopting another configuration.

The web surface passes the returned pinned `atyrode.code.accounts.sign-in`
runtime to native terminal creation on that same permitted, online owner.
The user's ordinary OMP `/login` flow owns OAuth, API keys, credential storage
and refresh in the owner-local managed OMP home. The native instance service
hosts OMP's broker against that same store, independently of terminal lifetime,
and authorized machines share it through native grants. Code does not collect
keys or callbacks or maintain a private authentication worker.

`omp-sign-in.tsx` refreshes setup and permitted account metadata live. Continue
appears only after a fresh, successful observation contains an account; OMP
stays open so more accounts can be added. Closing the Code view does not close
OMP. An account observation or terminal placement is not proof of provider
acceptance or an account-backed model response. This reference supplies no
authorization to use live credentials, relocate existing data or retire a broker.

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
requires `{ containerId, machineId, expectedRevision, mode: "create" | "existing" }`
and returns a native `PublicJob`:

- `mode: "create"` dispatches `atyrode.code.prepare-workspace` with native
  exclusive creation. Both declared directories must be new; existing directories
  are refused, never overwritten or silently adopted.
- `mode: "existing"` dispatches `atyrode.code.validate-workspace` with read-only
  workspace and sessions bindings. Both directories must already exist.
  Validation preserves them and does not create missing locations.

Both operations run the same pinned OMP version probe without network access.
Only the selected workspace route needs its exact consent: creation does not
also require the validation read grant, and validation does not require creation.
Model inventory and launch retain their separate permissions. Launch uses
separately consented write access, so later sessions reuse the locations.

Inspect the completed native result before launch. First-use setup reads and
refreshes both operations' retained histories and accepts a successful receipt
from either only when its installation revision, artifact hash and operation
binding digest match the current runtime. Completion survives reload; changed
runtime pins require a new successful proof. There is no local completion
shortcut or automatic fallback to creating folders after validation fails.

Preparation does not clone a repository or introduce a private workspace/session
registry. Native location and terminal lifecycle and OMP's own in-session
isolation remain their owners' responsibilities. Existing user data must not be
moved or deleted by inference.

## Headless clients and evidence

Root product actions are `atyrode.code.<name>` through Manifold's governed action
API; `readAccountSetup` and `prepareSignIn` belong to `atyrode.code.accounts`.
`ActionInput`, `ActionResult`, `actionSchemas` and `actionDoor` in `contract.ts`
define the exact boundary. `auth-contract.ts` defines shared broker and sign-in
operation identities, not a separate enrollment API. Web and agent clients use
the same authority and state; no printed-output protocol is
required. Babel depends on Code, not vice versa. Its native adoption is separate
and not claimed here; preserving an old engine ABI is not a Code prerequisite.

The current integration source is not a statement about main. The shared
preview's exact deployment and bounded live observations are recorded in
[status](status.md#source-is-not-deployment); they do not certify every workflow.
Production deployment, releases, credential relocation, broker retirement and
destructive state changes require separate authorization.
