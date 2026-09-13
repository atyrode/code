# Code as a Manifold-native plugin

## 1. Ratified product direction

**Manifold is the application; `atyrode.code` is a plugin within it.** The
operator ratified this replacement on 2026-09-08 in
[Code #149](https://github.com/atyrode/code/issues/149), with the ownership
cutover integrated under [#161](https://github.com/atyrode/code/issues/161).
This is not a web front end for an independently configured terminal product.

Code's implementation is TypeScript domain policy, governed actions and React
surfaces. It depends on Manifold's public native contracts and the independent
`atyrode.omp` plugin's typed client. OMP owns every machine runtime path. The
standalone Go program/module, launchers, Nix product outputs, runtime artifact
pins, workers, private stores, visual catalog parser and process protocol are
not compatibility requirements. No CLI recovery ceremony, environment
compatibility or publisher belongs in the replacement.
A hypothetical future CLI would be a native client, not today's scope.

**Babel depends on Code, not the reverse.** Code exports typed native headless
contracts. Downstream adoption is independent work: do not block Code on Babel,
claim Babel has adopted the new API or preserve a former engine ABI for it.
This task does not edit Babel or authorize changes to its live resources.

This document supersedes coexistence, publisher and CLI-first designs. Historical
reasoning remains in Git/issues. [AGENTS.md](../AGENTS.md) holds operating
authority, [configuration.md](configuration.md) documents current workflows,
and [status.md](status.md) records caveats. Section 6 is the sole progress ledger.

## 2. Ownership and native mechanisms

| Concern | Owner and current boundary |
| --- | --- |
| Catalogs, ladders, selection, routing, estimates, account-choice and usage projection | Code's typed `plugins/domain/` modules; no recovery from terminal output |
| Human and headless access | React surfaces and `createCodeWorkflowClient` use the same ordinary Manifold action transport across Code and OMP |
| Fleet, identity, grants and consent | Manifold's canonical principal/machine/container/resource scopes; no Code inventory, ACL or label-based retargeting |
| Durable product state and concurrency | Manifold plugin storage/migrations; Code owns one container record committed by native CAS |
| Broker, gateway, provider observations and credential controls | Independent `atyrode.omp` root/accounts/gateway plugins; Code receives typed permitted results only |
| Artifacts, bindings and installation | Manifold native resources and exact reviewed revisions; OMP alone declares its runtime artifacts |
| Jobs, cancellation, retained results and provenance | Manifold's native execution/history, invoked through OMP doors; no Code job database, proxy or second ledger |
| Workspaces and terminals | OMP-reviewed native location/job/session operations and Manifold terminal placement |
| Ordinary agent behavior | OMP retries/fallback, quotas, resume and in-session isolation; Code supplies no runtime control plane |

Manifold's [axioms](https://github.com/atyrode/manifold/blob/main/AXIOMS.md),
[contracts](https://github.com/atyrode/manifold/blob/main/docs/CONTRACTS.md) and
[plugin guide](https://github.com/atyrode/manifold/blob/main/docs/PLUGINS.md)
define reusable mechanisms. Missing platform capability belongs in its proper
native/plugin home under Manifold's Foundation law, not in privileged
Code/provider branches or a parallel registry, transport or scheduler.

### Implementation boundaries

Pure catalog, routing and preference operations run in Code plugin actions, not
machine jobs. The web renders typed previews, while authoritative changes use
the same governed Code/OMP workflow as headless callers. Native events
invalidate observations; Code has no replay queue. Unsaved editor state is
local, not a second preference authority. Concurrent edits refuse rather than
overwrite.

Everything requiring machine locality is owned by `atyrode.omp`: broker and
gateway workers, provider probes, workspace jobs and session construction. Code
imports the public caller API and dispatches its doors as the principal; it does
not proxy, package or configure OMP runtime work. Its only native service policy
is the optional external suggestion classifier.

## 3. Product workflows and shared state

| Workflow | Current source path and authority |
| --- | --- |
| Initialize and edit shared choices | Code `initializeConfiguration`, `select`, `changeAccounts`; `{ containerId }`, revision checks and native CAS |
| Catalog edit/review/promotion | Code `stageCatalog`, `reviewCatalog`, `promoteCatalog`; typed document and exact review digest, no machine process |
| Native permission review | Headless Code client composes exact `engine.jobs` deployment requests from OMP owner observations; no checked choice grants authority |
| Suggestion setup | Code `readServiceConfiguration`, `reviewServices`, `configureServices` bind only the optional external classifier |
| Accounts and usage | OMP accounts/usage/control doors own observations and effects; Code projects shared exact-slot choices |
| Account sign-in/runtime | OMP accounts owner reviews/promotes its broker and returns the sign-in terminal; Code receives no credential input |
| Gateway configuration | OMP gateway owner reviews/promotes destination service policy; Code has no gateway server |
| Inventory and benchmark | OMP starts/reads typed native receipts; Code `draftInventory`/`deriveCatalog` produce unpromoted catalog data |
| Reviewed session | Code `composeSession` freezes policy; OMP reviews/rechecks defaults, destination and accounts and returns `TerminalRuntimeSchema` |
| Workspace access | OMP owns separately reviewed create and existing-folder validation; no Code registry or cloning |
| Supervising clients | `createCodeWorkflowClient(dispatch)` is React-free; downstream clients adopt independently |

Catalog/preferences operations remain useful without execution readiness.
Missing machine/service resources are explicit per-operation unavailable states,
not a reason to hide stored state or silently choose another target. A returned
runtime, admitted job or terminal tile is not successful OMP execution.

Source retirement does not authorize importing, relocating or deleting live user
data. There is no automatic legacy-store adoption or synchronization path. Any
needed adoption is a separately authorized bounded native operation.

## 4. Execution resources, revisions and credentials

Manifold owns the generic resource/runtime/scoped-service contract. OMP consumes
it for managed artifacts, system/development tool closures, broker/gateway
services, workspace/probe/session operations and exact reviews. Code consumes
only the ordinary public OMP action contract; it has no machine manifest,
runtime-artifacts file, generated worker or private execution helper.

The selected policy is **explicit review of exact revisions at every owner**:
Code configuration/composition digest, OMP defaults and account observations,
native deployment review, destination installation/artifact/binding revisions
and service policy revisions. Each workflow re-observes its inputs immediately
before the effect and refuses a changed one. Product CAS, native deployment,
service configuration and provider freshness are distinct.

The credential boundary is the OMP accounts plugin's native scoped service
access. Owner-held secrets stay in its protected managed location. Ordinary
read, credential mutation, broker configuration, gateway invocation and Code
preference mutation retain separate authority. No credential or service bearer
belongs in Code's browser inputs, configuration, server, bundle, argv, logs or
output.

Moving from the historical Code-owned broker to OMP changes the native service
scope intentionally. Saved Code choices may be rebound only after an explicit
live observation proves the same provider, positive credential id and concrete
identity/slot under the OMP owner. Ambiguous email matching, a scope alias or
automatic fan-out would silently broaden authority and is prohibited.

## 5. Cutover and acceptance

This is replacement, not dual-product interoperability. Remove obsolete Code
interfaces, implementation paths, build/release dependencies and tests that
only pin the removed process or visual formats. Keep domain/security behavior:
valid ladders, image-safe routes, exact preview-to-launch resolution, typed
estimates, no account-pool broadening, freshness and honest probe outcomes.

| Scenario | Failure condition |
| --- | --- |
| Clean plugin build/install | Requires Go, a Code binary/wrapper, Code runtime artifacts, legacy state paths or fabricated OMP bundles |
| Catalog/preferences with offline machines | Requires a machine process or falsely claims execution readiness |
| Two principals, web and headless clients | Different action paths, stale overwrite, or Code ACL/replication substitute |
| Changed Code/OMP/native revisions | Silently uses a different reviewed input instead of refusing stale use |
| First use, accounts, catalog, suggestions, session | Hidden CLI ceremony, unsupported account kind, fake dependency or placeholder substitutes for capability |
| OMP read/mutation/runtime authority | Read grants mutation/setup authority, source secret escapes, account selection broadens or revoked authority causes an effect |
| Real OMP, reconnect and cancellation | Admission/tile is reported as provider success or worker/child escapes native ownership |
| Native workspace lifetime | Private Code registry/transport remains required, or validation silently creates |
| Reusable native primitive | Behavior depends on a privileged Code/OMP identifier rather than generic contracts |

Source gates, built artifacts, disposable-server dispatch, browser interaction and
real machine/provider behavior establish different facts. Run the safe available
scenarios, not a synthetic success in place of unavailable authority. Before
requesting operator testing, identify the exact installed revision, normal hub
URL, panel/action, expected observation and remaining boundary. No live
credentials, broker retirement, release, deployment or destructive state action
is authorized merely to fill an evidence gap. Production installation remains
operator-controlled; tags and published bytes remain immutable.

## 6. Transition steps

This is the only progress ledger. A PR moving a step updates its row. `in progress`
does not mean shipped; `shipped` means on main; `proven` requires actual dated
step-specific evidence. The current integration source descriptions below are
not merge or operational acceptance claims. Main's integration owner records
final pins, gates and runtime evidence.

| Step | Status | Evidence and remaining acceptance |
| --- | --- | --- |
| 0 — architecture | ratified | Operator direction on 2026-09-08, #149: Code is Manifold-native; #161 separates OMP into its own native plugin while Code remains policy/presentation. Babel is downstream. Documentation is not implementation proof. |
| 1 — plugin resources and operations | in progress | Current integration packs three OMP runtime bundles and four Code policy/presentation bundles. Real required-dependency ordering, in-memory compilation and exact Git/Manifold pins replace Code staging and duplicated runtime manifests. Final pins, merged CI and operational resource evidence remain. |
| 2 — web-controlled launch | in progress | `createCodeWorkflowClient` composes Code policy and OMP review/prepare doors; the workbench rechecks composition/defaults/destination before passing OMP's terminal descriptor to native placement. Disposable browser evidence proves refusal and interaction, not account-backed execution or lifecycle. #98 remains. |
| 3 — native workspace and multiplayer | in progress | Configuration is one container CAS with a named native schema-2-to-3 migration. Existing and create workspace routes are separately reviewed OMP jobs. Two ordinary browser identities share state while destination changes preserve prompts/drafts. Live workspace/session evidence remains under #99. |
| 4 — accounts and usage | in progress | OMP owns account/runtime/sign-in/usage doors and real broker/gateway workers; Code owns exact-slot choices and usage projection. Browser evidence covers freshness/refusal and Code controls; packaged OMP tests cover reconnect, shutdown, redaction and concrete-slot fallback without providers. Preview custody/rebind and account-backed proof remain under #100/#105/#106. |
| 5 — catalog, suggestions and first use | in progress | Code retains typed catalog/routing and external suggestion policy; OMP owns defaults, inventory and benchmark receipts. The headless permission plan is the web path, exposes independent choices and never equates review with authority. Final pinned gates and real provider/session evidence remain under #103/#152. |
| 6 — retire deprecated implementation | in progress | #161 removes the Go/CLI/Nix/state/runtime-worker surface, Code broker/gateway/probe artifacts and obsolete tests after explicit reachability checks. Four Code bundles depend on the real OMP owner with no shim. Merge, CI and bounded preview data/custody acceptance remain before shipped/proven. |

Draft #148's prototype commit
`381ac912707e1ccc2b6ecbf8f4dcc75c8e99ab17` and the 2026-09-09 five-Code-bundle
preview apply only to that historical implementation. They do not certify this
cutover. #161 records the cross-repository source integration; merge, releases,
native review, preview custody and account-backed runtime evidence remain
separate.
