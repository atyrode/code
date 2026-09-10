# Code as a Manifold-native plugin

## 1. Ratified product direction

**Manifold is the application; `atyrode.code` is a plugin within it.** The
operator ratified this replacement on 2026-09-08 in
[Code #149](https://github.com/atyrode/code/issues/149), with integration under
[#102](https://github.com/atyrode/code/issues/102). This is not a web front end
for an independently configured terminal product.

Code's implementation is TypeScript domain logic and governed actions, React
surfaces and Bun machine-local workers. It depends on Manifold's public native
contracts and OMP's agent runtime. The standalone Go program/module, launchers,
Nix product outputs, release machinery, private stores, visual catalog parser
and process protocol are not compatibility requirements. No CLI recovery
ceremony, environment compatibility or publisher belongs in the replacement.
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
| Catalogs, ladders, selection, routing, estimates, account-choice and usage semantics | Code's typed `plugins/domain/` modules; no recovery of meaning from terminal output |
| Human and headless access | React surfaces and `atyrode.code.<action>` through Manifold; `contract.ts` / `auth-contract.ts` define typed requests and results |
| Fleet, identity, grants and consent | Manifold's canonical machine/container/resource scopes; no Code inventory, ACL or label-based retargeting |
| Durable product state and concurrency | Native plugin storage; Code checks container authority and commits one target-scoped record with `ctx.storage.compareAndSet`, revision and attribution |
| Credential sources and service policy | Native owner-held references/resolver, scoped service contracts and policy revisions; Code supplies domain policy adapters, never a credential authority |
| Artifacts, bindings and installation | Native managed resources and exact reviewed revisions; no separately configured Code installation |
| Jobs, cancellation, retained results and provenance | Native job execution/history; no publisher, timer service, job database or second audit ledger |
| Workspaces and terminals | Native location bindings and terminal lifecycle; declarations do not prove repository/worktree preparation exists |
| Ordinary agent behavior | OMP's retries/fallback, quotas, resume and in-session subagent isolation; terminal is an execution surface, not Code's control plane |

Manifold's [axioms](https://github.com/atyrode/manifold/blob/main/AXIOMS.md),
[contracts](https://github.com/atyrode/manifold/blob/main/docs/CONTRACTS.md) and
[plugin guide](https://github.com/atyrode/manifold/blob/main/docs/PLUGINS.md)
define reusable mechanisms. Missing platform capability belongs in its proper
native/plugin home under Manifold's Foundation law, not in privileged
Code/provider branches or a parallel registry, transport or scheduler.

### Implementation boundaries

Pure catalog, routing and preference operations run in plugin actions, not
machine jobs. The web can render typed previews, but authoritative changes use
the same governed boundary as agents. Native events invalidate observations;
Code does not maintain a replay queue. Unsaved editor state is local, not a
second preference authority. Concurrent/stale edits refuse rather than overwrite.

Workers require actual machine locality: OMP probes, native OMP sign-in and
the scoped OMP protocol gateway. They use the native SDK's input, cancellation,
service and job contracts. The gateway is governed by its native lifetime and
is not a provisioning daemon, broker replacement or credential store. No
standalone worker executable is an operator-facing Code product.

## 3. Product workflows and shared state

| Workflow | Current source path and authority |
| --- | --- |
| Initialize and edit shared choices | `initializeConfiguration`, `select`, `changeAccounts`; target `{ containerId, machineId }`, revision checks and native CAS |
| Catalog edit/review/promotion | `stageCatalog`, `reviewCatalog`, `promoteCatalog`; typed document and exact review digest, no machine process |
| Native resource adoption | `readSetup`, `reviewResources`, `promoteResources`; observe/adopt exact pins, not installation or consent |
| Service setup | Owner-only `readServiceConfiguration`, `reviewServices`, `configureServices`; existing native references and reviewed policy revisions, no raw secrets |
| Accounts and usage | `accounts`, `usage`, `clearAccountBlocks`, `disableCredential`; scoped service read/mutation authority, shared account-choice meaning |
| Account sign-in | `readAccountSetup` and `prepareSignIn` observe the configured native instance owner, create or reuse its shared OMP broker, and return a pinned terminal handoff. OMP's ordinary `/login` owns OAuth/API-key entry and persistence; Code receives no credential input |
| Shared account runtime upgrades | `reviewAccountRuntime` and `promoteAccountRuntime` bind explicit owner authority, broker revision and reviewed runtime digest; no silent upgrade or independent broker supervisor |
| Inventory and benchmarking | `startInventory` / `inventory`, `startBenchmark` / `benchmark`, `stageBenchmark`; explicit potentially paid provider requests and retained typed receipts, never automatic promotion |
| Suggestions | `suggest` invokes the promoted scoped classifier, validates and returns a revision-bound selection; saving remains explicit |
| Reviewed launch | `previewLaunch` binds routes/account slots/resource pins; `prepareLaunch` rechecks and returns `TerminalRuntimeSchema`; `host.authoring.createTerminal` delegates placement to the mounted native renderer |
| Workspace/session access | `prepareWorkspace` creates declared new locations and probes pinned OMP through a native job; launch reuses them with write consent. No cloning or private worktree registry |
| Supervising clients | Typed native product actions and native job/runtime references; downstream clients adopt independently |

Catalog/preferences operations remain useful without execution readiness.
Missing machine/service resources are explicit per-operation unavailable states,
not a reason to hide stored state or silently choose another target. A returned
runtime, admitted job or terminal tile is not successful OMP execution.

Source retirement does not authorize importing, relocating or deleting live user
data. There is no automatic legacy-store adoption or synchronization path. Any
needed adoption is a separately authorized bounded native operation.

## 4. Execution resources, revisions and credentials

[Manifold #447](https://github.com/atyrode/manifold/issues/447) owns the native
resource/runtime/scoped-service requirement, refining
[#153](https://github.com/atyrode/manifold/issues/153). Code consumes those
contracts rather than matching an installed Code command or wrapper.

`runtime-artifacts.json` records managed Bun 1.4.2, OMP/SDK 18.1.14 and pi-natives
pins for Linux x64/arm64. The packer bundles TypeScript workers and generates
artifact/tool declarations. Every operation declares the required
`runtimeTools.system` closure. The native owner must independently supply,
review and promote its interpreter and transitive libraries; direct ELF
requirements in `native-requirements.json` are not a ready closure. No PATH,
host filesystem or incidental cache fallback is permitted. An unconfigured
owner must report unavailable resources and refuse admission.

The selected policy is **explicit promotion of exact revisions**: product
bundle hash, configuration/catalog revision, execution installation/artifact
and operation binding digests, service revisions and policy hashes. Review and
startup must not silently resolve different inputs. Resource promotion neither
provisions a machine nor grants consent. Fresh usage and equivalent secret
rotation are not software upgrades; their freshness/authority still need truthful
semantics.

The selected credential boundary is **native scoped service access**. Owner-held
source refs are available only for their declared origins. Service configuration
requires native owner authority and revision-checked review. Account sign-in is
an ordinary pinned OMP terminal on the instance broker owner, using OMP's
supported `/login` flow rather than a Code enrollment worker or credential form.
Read, credential mutation and runtime authority remain separate. Provider secrets
stay in the broker owner's native managed home or their existing protected source.
Only declared scoped service capabilities reach jobs; no provider secret belongs
in Code's browser inputs, configuration, hub records, argv or ordinary output.
Scoped access does not prevent a process from disclosing data it can legitimately read.

Code creates or reuses the configured instance-wide OMP broker through Manifold's
native service lifecycle, after exact runtime/resource review. It neither starts
a private supervisor nor turns external broker setup into a standalone prerequisite.
Workspace bindings are likewise not proof of workspace preparation. Use native
resource lifecycle and report missing capabilities rather than inventing a
Code daemon, SSH helper or terminal-as-transport workaround.

## 5. Cutover and acceptance

This is replacement, not dual-product interoperability. Remove obsolete Code
interfaces, implementation paths, build/release dependencies and tests that
only pin the removed process or visual formats. Keep domain/security behavior:
valid ladders, image-safe routes, exact preview-to-launch resolution, typed
estimates, no account-pool broadening, freshness and honest probe outcomes.

| Scenario | Failure condition |
| --- | --- |
| Clean plugin build/install | Requires Go, a Code binary/wrapper, Nix Code product or legacy state directories |
| Catalog/preferences with offline machines | Requires a worker/broker for pure computation or falsely claims execution readiness |
| Two principals, web and agent clients | Different authority/state paths, stale overwrite, or Code ACL/replication substitute |
| Changed state/product/execution/service revisions | Silently uses different reviewed inputs instead of refusing stale use |
| First use, account types, catalog, suggestions, launch | Hidden CLI ceremony, unsupported required account path, missing artifact or placeholder substitutes for capability |
| Scoped service reads/mutations and revocation | Read grants mutation/runtime authority, source secret escapes, account selection broadens or revoked authority causes an effect |
| Real OMP, reconnect and cancellation | Admission/tile is reported ready or gateway/child escapes its native owner |
| Native workspace lifetime | Private Code registry or terminal transport remains required; declared locations are misrepresented as implemented preparation |
| Reusable native primitive | Behavior depends on a privileged Code/provider identifier rather than generic contracts |

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
| 0 — architecture | ratified | Operator direction on 2026-09-08, #149: Code is Manifold-native, with scoped services, explicit exact-revision promotion and one native state authority. Babel is a downstream consumer, not a prerequisite. Documentation is not implementation proof. |
| 1 — plugin resources and operations | in progress | Bootstrap packaging shipped in #107; Manifold #429/#445/#446 supplied earlier runtime/job/storage work. Current integration packs five TS/React/Bun bundles, with an independently installed model gateway avoiding circular service pins, under Manifold #448. Required owner-provided system closure, final exact pins and operational resource evidence remain distinct. |
| 2 — web-controlled launch | in progress | Current source provides shared dials, exact launch preview, `prepareLaunch` and native terminal placement. The 2026-09-07 old-terminal preview and #148's 2026-09-08 isolated checks were prototype evidence only. Current actual OMP readiness, account-backed execution and native lifecycle evidence remain; #98 stays open. |
| 3 — native workspace and multiplayer | in progress | Native storage CAS, scoped configuration, declared location creation plus a real OMP version probe, and separately consented repeated launch writes. No private registry or repository cloning. Full native lifetime, two-principal web/agent equivalence and runtime composition require evidence; #99 stays open. |
| 4 — accounts and usage | in progress | Current source has Accounts/Usage panels, scoped service actions, shared choices, a native instance-owned OMP broker, ordinary OMP `/login` terminal handoff and explicitly reviewed shared-runtime upgrades. Code accepts no credentials and has no enrollment worker. Live projected broker metadata has been read through native authority; complete account workflows, provider sign-in and multiplayer proof remain. #100/#105/#106 stay open. |
| 5 — catalog, suggestions and first use | in progress | Current source has typed catalog editing/review/promotion, native inventory/benchmark receipts, scoped suggestions and resource/service setup. First-use permission review is reachable before model setup, and folder preparation follows a retained successful native job rather than local React state. A disposable no-network preparation job exited successfully on 2026-09-10; that does not prove shared-preview acceptance or provider workflows. Complete first-use and real provider/runtime evidence remain under #103 and #152. |
| 6 — retire deprecated implementation | not completed | Current integration performs the TypeScript-only source/build/docs cutover rather than preserving the old Go/CLI/state/visual-format paths. This is not a claim that main has merged it. Final integrated retirement evidence remains under #101; downstream clients adopt native Code independently and live data handling requires separate authority. |

Draft #148's recorded prototype commit was
`381ac912707e1ccc2b6ecbf8f4dcc75c8e99ab17`; its historical Go/plugin gates and
2026-09-08 isolated smokes apply only to that implementation. They do not certify
this cutover. The broader integration record remains #102, without a publisher
or wrapper-preservation requirement. The shared preview's exact deployment and
bounded live observations are recorded in [status](status.md#source-is-not-deployment);
they do not imply a main-branch merge or complete runtime acceptance.
