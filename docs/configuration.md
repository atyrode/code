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

`plugins/code/contract.ts` is authoritative. Shared state is addressed
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

| Purpose               | Actions                                                                      |
| --------------------- | ---------------------------------------------------------------------------- |
| Configuration         | `readConfiguration`, `initializeConfiguration`, `select`, `changeAccounts`   |
| Catalog authoring     | `stageCatalog`, `reviewCatalog`, `promoteCatalog`                            |
| Pure OMP input policy | `composeProbe`, `draftInventory`, `deriveCatalog`, `composeSession`          |
| External classifier   | `readServiceConfiguration`, `reviewServices`, `configureServices`, `suggest` |

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

Known providers may add named families, quota metadata, special tiers, priority
or off-peak behavior. A provider without such a policy is still a complete
provider family: its exact provider identifier is the family, its declared
rungs may fill missing capability tiers, and Code adds no cross-provider lane,
quota bucket, priority or special-tier assumption. A nonreasoning inventory
model is represented by the single `minimal` routing level rather than excluded.
Launch composition still requires a fresh selected account for every exact
provider and leaves final model resolution to OMP.

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

The one-shot `atyrode.code.runSession` door additionally accepts ephemeral
`inferenceLimits`: any nonempty combination of `calls`, `inputTokens`,
`outputTokens` and `costMicros` from OMP's exported native schema. Code carries
the requested limits through native review and refuses missing or changed
admitted limits, including on later receipt reads. Cancellation still targets
the same proven job when its limits no longer match. Cost review requires native
metering and reviewed prices for the served models. These limits are not saved
in profiles and are not supported for terminal or harness preparation.
Metering checks before each call; an in-flight response can exceed token or cost
thresholds. These are not zero-overshoot spending caps. Native metering does not
establish a cumulative spending ledger or a worst-case provider retry/token
envelope; a bounded live rehearsal still requires both.

### Optional skills for one launch

`workflow.readSkillCatalog({ containerId, machineId })` calls OMP's native
`readSkillCatalog` action as the caller. This is a separate, machine-scoped OMP
catalog, not Code's model catalog or shared profile state. Its owner publishes
reviewed metadata with native `writeSkillCatalog` compare-and-set. Code neither
downloads skills nor accepts host paths or skill bodies. Each entry identifies
one immutable sealed job output and its SHA-256, native name, purpose, content
revision, license, review provenance and declared conflicts. Metadata reads authorize
the target and remain available to repair stale entries. Native catalog writes and
selection recheck source-job read/export authority, machine identity and sealed digest;
reading catalog metadata does not grant access to its sources.

`workflow.reviewSession(target, expectedRevision, prompt, { skills?, automation?, inferenceLimits? })`
accepts one optional options object. Its `skills` field is OMP's own schema:

- Omitted: select no optional entries; ordinary launches preserve permitted
  core/project loading. Restricted launches suppress ambient discovery.
- `{ mode: "select", expectedCatalogRevision, skillIds, setIds }`: select the
  deterministic union of entries and deliberate sets at that exact revision.
- `{ mode: "disabled" }`: disable every skill source and skill advertisement.

The returned native review includes `skills` with `mode`, `catalogRevision`
and `selected` metadata. `workflow.prepareSession(review)` uses that effective
native selection, not a fresh expansion of the original sets. Native review
binds the revision and immutable sources. Stale catalogs, unavailable or changed
source jobs, lost authority, conflicting names, declared conflicts and more than
15 optional entries refuse; Code does not substitute another source. Only OMP's
native loader loads approved paths. Ordinary project skill filters remain authoritative
and can suppress a selected source. Selection is not evidence of loading or invocation.

The ordinary `atyrode.code.runSession` one-shot door accepts the same `skills`
field alongside its existing prompt, profile revision and material input. It
re-observes Code composition and OMP defaults, consumes the native-reviewed
selection, and fences the returned job against both material and native-derived
optional input bindings. Optional source bindings never replace the caller's
material. Independent headless calls have no inherited skill choice.

The workbench presents available and selected metadata, deliberate sets and
conflict reasons. Choices are local to the pending launch: unrelated navigation
and refresh retain them; destination changes, a successful terminal placement
and a fresh workbench clear them. “Clear optional choices” preserves ordinary
loading only in ordinary mode; restricted mode still suppresses ambient loading.
“Disable all skills” suppresses every source. A changed catalog revision leaves a
visible stale draft, invalidates its review and requires clearing/reselecting
against current metadata. No skill choice is saved in Code preferences, routing
facets or OMP defaults. Code does not guess resume selections from transcripts;
explicit per-session choices can also be supplied to the resume workflow below.
Selected or disabled optional-skill policies cannot be combined with plan-yolo;
native preparation refuses rather than falling back to ordinary loading.

### Restricted automation for one launch

The optional `automation` field on workflow review and `atyrode.code.runSession`
uses OMP's exported `RestrictedAutomationSchema`:
`{ mode: "restricted", toolNames: ["read"], delegation: "disabled" }`.
OMP owns and exports `RESTRICTED_TOOL_NAMES`: `read`, `grep`, `glob`, `bash`,
`edit`, `write`. The exact, unique subset may be empty. Unknown tools, duplicate
entries, unsupported modes and enabled OMP task/advisor delegation refuse; Code does not silently
filter a request. Omission leaves ordinary new-session behavior unchanged.
Restricted automation is supported for terminal and one-shot sessions, not
harness preparation, and cannot be combined with plan-yolo.

The native review always reports effective `automation`, either ordinary or the
restricted object. Both terminal preparation and one-shot posting carry that
reviewed policy, not a client-reconstructed allowlist. OMP's SDK registry restriction
is the enforcer; the browser chooser is not one. Restricted sessions suppress
ambient core/project/discovery loading and OMP task/advisor spawning, loading only
deliberately selected sealed skills through OMP's loader. Disable-all loads none.
Skills are instructions, not authority. Tool limits are not an OS/network sandbox:
permitted bash can launch subprocesses, including another OMP process.

Policy, tool, skill, prompt, profile, defaults and destination changes invalidate
launch reviews. In-flight results are fenced even after a round-trip change.
Choices reset after successful placement or a destination change; no restricted
default is stored in a shared profile.

### Native fleet discovery and next-resume choices

`workflow.listSessions(machineId)` returns OMP's bounded header/title metadata
only (`id`, `title`, `cwd`, `updatedAt`), never message bodies or transcript paths.
The workbench requests each permitted machine explicitly and distinguishes pending,
failed, unavailable and empty inventories. Native metadata is not a fleet archive.
`workflow.runningSession(ref)` correlates only the exact harness, machine and session
ID in public running-terminal metadata. A matched terminal supplies its authoritative
current home; an old terminal without correlation remains unknown, regardless of
matching title or directory.
`workflow.resumeSession(ref, { profile?, skills?, automation? } = {})` accepts
OMP's `{ harness: "atyrode.omp", machineId, sessionId }` reference.

- Omit `profile` to resume saved state without injecting model, thinking, overlay
  or account-pool replacements. OMP preserves persisted model and configured
  thinking, not historical tool restrictions or selected skills.
- Supply `profile: { target, expectedRevision }` to compose that exact current
  Code profile. Code sends the default role's exact model and thinking as explicit
  native `overrides`, plus the composed overlay and exact account pool. A
  cross-machine target or stale Code revision refuses, not a fallback to defaults.
  A profile enabling plan-yolo also refuses native resume.
- Optional skills/automation are deliberate per-resume choices. Omitted automation
  uses ordinary behavior; omitted skills preserve ordinary permitted ambient
  loading, not a historical selection. Choose restricted mode explicitly again
  when needed; with no deliberate skill selection, restricted resume loads none.
  Native missing, incompatible or unavailable model/thinking state refuses before
  a replacement session or inference can be created.

The workbench offers separate **Resume saved state** and **Resume with this
profile** actions after explicitly listing and selecting native saved state.
Local unsaved profile edits cannot be resumed as a profile. The workflow refreshes
the machine roster, native inventory and public terminals before preparing a resume.
It returns either `{ kind: "reopen", terminals }` for an exact running match, or
`{ kind: "prepared", prepared }` for native continuation. The UI reopens through the
public terminal URI; it never creates a replacement terminal for a known match.
Machine changes and late responses cannot carry an earlier selection into a new
destination. Code checks both the prepared runtime correlation and session identity,
carries native refusals and uses the native placement seam; preparation does not
grant placement permission.

These are explicit next-resume choices, not live effective-settings inspection.
Portable archive/import recovery and general settings-origin readback are not planned.

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
Broker promotion may also review an exact unprivileged loopback bind and
SHA-256 bearer verifier for existing clients. Omitting that field retains the
current declaration; `null` explicitly removes it. Plaintext client bearers
remain outside the review, policy serialization and Code.
A paused broker remains disabled during reads and sign-in preparation. Its
owner can review and explicitly promote recovery against the exact paused
revision, native permissions and retained client-access declaration.

A move from an older Code-owned broker changes the service scope by design.
Operational cutover must first prove the same concrete provider, credential id
and identity slots under the new OMP owner, then update saved choices through
revision-checked `changeAccounts` with `change: { kind: "rebind-scope", previous,
current }`. These are permitted account-metadata observations retained before
and read after cutover, never raw broker snapshots. The action requires a
one-to-one unchanged provider/credential/identity population and moves every
manual and preset exclusion in one revision. Missing evidence or changed slots
refuse without changing choices; no compatibility alias, email-only match or
intermediate widened pool is created. Credential bytes and protected backups
are not part of Code configuration.

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
in real browsers. Its credential-free fixture proves composition, refusal and UI
behavior. The 2026-09-13 preview acceptance separately exercised real native
workspace, inventory and account-backed terminal paths on both enrolled
destinations; [status](status.md) records the exact revisions and boundaries.

Babel may consume the headless boundary independently; Code does not depend on
Babel or retain an old process ABI for it. Source, merge, CI, release,
installation, native consent, provider response and custody transfer remain
separate authority and evidence. Production changes, credential relocation,
backup disposal and destructive data changes require separate authorization.
