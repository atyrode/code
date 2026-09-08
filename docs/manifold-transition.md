# Code as a Manifold-native plugin

## 1. Ratified product direction

**Manifold is the application; `atyrode.code` is a plugin within it.** The
operator ratified this replacement on 2026-09-08 in
[Code #149](https://github.com/atyrode/code/issues/149). The standalone Code
CLI/TUI is deprecated. This is not a web front end for an independently
configured terminal product, and compatibility with that product is not an
architectural requirement.

Code is piloted through Manifold's web GUI and governed APIs. Its fleet access,
permissions, multiplayer state, persistence, resources, execution and
traceability use Manifold. Missing reusable capability is implemented there,
not bypassed with Code infrastructure. Useful Go domain behavior may be reused;
the old program's packaging, state files and control flow do not define the new
product boundary.

A future CLI, if requested, would be designed as a client of this architecture.
There is no requirement to preserve the present CLI/TUI, `CODE_*` compatibility,
a dotfiles Code wrapper, terminal configuration ceremonies, CLI-only features,
dual preference stores or a permanent standalone recovery path. Existing source
still containing those things is evidence of work remaining, not a competing
mandate. Source retirement and safe handling of live resources are separate
from preserving an obsolete product design.

This document replaces the earlier coexistence, publisher and CLI-first plans.
Historical reasoning remains in Git and issue history, not as active alternate
guidance in this file. The local operating contract is [AGENTS.md](../AGENTS.md);
implementation caveats are [status.md](status.md). Section 6 is the sole progress
ledger.

## 2. Ownership and native mechanisms

| Concern | Owner and contract |
| --- | --- |
| Model/catalog semantics, capability ladder, estimates, routing, suggestions and account-choice meaning | Code's plugin domain logic. Reuse valid algorithms, not the standalone application's surrounding infrastructure. |
| User controls and automation | Code contributes web surfaces and typed actions through the public SDK. Humans and agents reach the same governed concepts. An API is not a reason to require a CLI. |
| Fleet discovery and execution targeting | Manifold's enrolled machine identities, availability and native resource requirements. No Code fleet inventory or label-based retargeting. |
| Identity, permissions, sharing and revocation | Manifold's grant model on canonical resources. No Code ACL or credential ceremony. Read access is not launch, write or credential-administration authority. |
| Durable Code state | One authoritative home through the appropriate native settings/document/action/storage mechanisms, with native ownership, concurrency and attribution. No CLI-file mirror or second state authority. |
| Resource provisioning, bindings, retention and retirement | Manifold's native lifecycle. External infrastructure can be an explicitly governed resource without becoming an independent Code product prerequisite. |
| Jobs, schedules, cancellation, retained results and provenance | Native execution and history. No Code publisher, timer service, job database, cross-launch registry or second audit ledger. |
| Workspace and worktree lifetime | Native resource/workspace lifecycle. Code requests the required capability instead of preserving its own whole-session registry. |
| Ordinary omp session behavior | Omp retains inference/runtime concerns such as model fallback, retries, quotas, resume and in-session subagent isolation. Code does not recreate them. |
| Terminal lifecycle and placement | Manifold. An omp terminal is an execution surface inside the workspace, not Code's control plane or an RPC tunnel into the old TUI. |

Manifold's [axioms](https://github.com/atyrode/manifold/blob/main/AXIOMS.md),
[contracts](https://github.com/atyrode/manifold/blob/main/docs/CONTRACTS.md) and
[plugin guide](https://github.com/atyrode/manifold/blob/main/docs/PLUGINS.md)
define the actual mechanisms. Code must adapt to those contracts, not invent a
parallel mechanism with similar names. Reusable capability need not all become
engine code: apply Manifold's Foundation law to choose its proper native/plugin
home. Code's domain nouns do not belong in a privileged platform exception.

## 3. Product workflows and shared state

The launcher, catalog generation and review, routing preview, suggestions,
usage/account management, session controls and supervising-client integration
must be designed around native plugin capabilities. There is no permanent
CLI-only exemption for generation, onboarding, authentication, worktrees or the
old `code engine` ceremony. Other products consuming Code do so through the
new governed boundary, not a requirement to preserve its former public process
interface.

Code's durable choices are Manifold-owned state, not copied CLI defaults that
remain authoritative elsewhere. A bounded one-time adoption of useful existing
data may be offered when needed; it is neither mandatory standalone setup nor
ongoing synchronization. Credential values are not preference data.

Choose state planes by Manifold's existing rules. Permission-dependent changes,
revision promotion and launching belong at governed action boundaries. Shared
editable content uses native document mechanisms where their merge semantics
fit; transient attention uses presence. Events notify clients to read current
state rather than introducing a Code queue or replay system. Use native
concurrency and conflict handling; one participant must not silently overwrite
another's reviewed choices or make a stale preview look current.

Data and operations have native ownership and scopes, including who can see,
change, share or execute them. If a storage API alone cannot supply a required
scope, revocation rule or attributable commit, implement the missing reusable
primitive in Manifold. Do not patch around it with a Code-only permission or
replication layer. Product schemas and interpretation remain Code's work.

The intended launch flow is:

1. Discover permitted fleet targets and their native resource readiness.
2. Review catalog, routing, account choices and relevant observations in the web
   surface, through the same APIs available to agents.
3. Commit the intended launch against the reviewed product-state and execution
   resource revisions, under current authority.
4. Start omp through Manifold's native runtime/terminal facility with the required
   workspace and narrowly scoped service access.
5. Observe real readiness, lifecycle, results and attribution through native
   surfaces. Terminal creation alone does not prove omp became ready.

No step requires first configuring a standalone `code` command. A private
machine-side executable may be necessary to perform domain work, but it is a
plugin implementation artifact managed through native lifecycle, not another
operator-facing product or control service.

## 4. Execution resources, revisions and credentials

[Manifold #447](https://github.com/atyrode/manifold/issues/447) owns the immediate
native resource/runtime/scoped-service requirement, refining
[#153](https://github.com/atyrode/manifold/issues/153). It no longer means
matching a preinstalled Code CLI or dotfiles wrapper.

The plugin declares the tools, configuration/catalog resources and services it
needs. Manifold resolves and governs them on the execution target. Reuse native
installation, resource, job and terminal contracts before adding vocabulary.
“Execution profile” is only a working description of a reviewed binding; it is
not a mandate for a new profile registry alongside existing native systems.

The operator selected **explicit promotion of exact revisions**. Planning and
runtime startup use the same reviewed tool/configuration resolution. A changed
revision requires fresh review and produces a named stale/refused result, never
silent host-PATH discovery, ambient environment inheritance or different settings.
Availability is per machine and operation: one missing dependency does not turn
off the entire plugin or hide otherwise usable fleet targets. Live quota changes
and equivalent secret rotation are not software/configuration upgrades; their
freshness and authority still need their own truthful semantics.

The operator selected **native scoped service access**. Upstream broker secrets
stay behind their machine-side resolver. Read jobs receive only the required
service operations; runtime and credential-administration access are separately
authorized. Do not silently fall back to handing a worker a raw upstream broker
credential if scoped access is unavailable. This prevents exposure of that
upstream authority; it does not mean a process cannot disclose data it is allowed
to read. Secret values must not enter browser/plugin inputs, hub records, argv,
logs or ordinary job output.

Existing brokers or other services may remain external resources while Manifold
provides their governed integration. That is not a requirement for a legacy Code
installation, copied credentials, or a second configuration manager. Provisioning,
adoption and retirement use explicit native operations, not a Code migration
script, publisher daemon, SSH helper or terminal-as-transport workaround.

## 5. Cutover and acceptance

This is a replacement, not a promise to keep two applications interoperable.
Retire obsolete public interfaces, implementation paths and tests through explicit
cutovers. Preserve tests for real domain/security behavior; do not retain a CLI
surface solely to satisfy old parity assertions. Acceptance is the new product's
user capabilities and native platform guarantees, not a reproduction of every
terminal key, glyph, command or old file format.

The architecture decision does not authorize destructive live actions. Existing
user data, other consumers' resources and credentials must be handled deliberately.
Releases/tags, production or fleet activation, broker retirement and credential
relocation still require their applicable authorization. Protecting live data is
not an excuse to make old state formats or a standalone fallback part of the
new architecture.

A meaningful implementation proof must exercise the actual plugin boundary:

- web and agent access to the same typed, governed operations;
- native machine/resource discovery and useful explicit refusal states;
- shared state, concurrent edits, stale revisions, scoped access and revocation;
- real scoped service reads without disclosing upstream secrets;
- inspected resource revisions carried into a real native runtime launch;
- attributable native lifecycle, cancellation, reconnect and result visibility;
- first-use setup and recovery through native capabilities rather than a hidden
  requirement to configure the deprecated application.

Run source gates and actual browser/machine scenarios appropriate to the change.
Installed bundles, live resources and successful Code/omp behavior are distinct
facts. Before asking the operator to test, perform the available safe end-to-end
checks and provide the exact deployed revision, ordinary hub URL, panel/action,
expected result and remaining boundary. There is no current instruction for the
operator to import account state or launch Code merely to compensate for missing
implementation.

## 6. Transition steps

This is the only progress ledger. A PR moving a step updates its row. `in progress`
does not mean shipped; `shipped` means on `main`; `proven` requires the actual
step-specific evidence and date. Earlier prototype evidence is retained below
without treating the rejected architecture as accepted.

| Step | Status | Evidence and remaining acceptance |
| --- | --- | --- |
| 0 — architecture | ratified | Operator direction on 2026-09-08, #149: standalone Code is deprecated; the product is Manifold-native in every aspect. Scoped service access, explicit exact-revision promotion and one native state authority are selected. This document replaces the old coexistence/publisher/CLI-first plan. Documentation is not implementation proof. |
| 1 — plugin resources and operations | in progress | Bootstrap packaging shipped in #107; dev/CI/release plumbing exists (atyrode/manifold#319). The governed runtime, job discovery and atomic storage landed in Manifold #429/#445/#446. Draft #148 contains reusable worker and operation work; its standalone-wrapper assumptions require rework. Native managed resources and scoped services remain under Manifold #447. No artifact, binding or live Code readiness is inferred from those merges. |
| 2 — web-controlled launch | in progress | The earlier panel shipped in #107. A 2026-09-07 preview proof opened the old interactive Code terminal and retained the panel; that proves only the bootstrap composition. Draft #148 adds candidate web dials and launch preparation. Its 2026-09-08 isolated-hub browser/native-dispatch checks do not prove the ratified plugin-native launch or real dev-01 account execution. #98 remains open. |
| 3 — native workspace and multiplayer | in progress | Draft #148 uses native panel placement and tests concurrent shared-choice proposals. Full native data ownership, scopes, web/agent equivalence and runtime composition require proof under the new architecture. #99 remains open; a private Code workspace/session registry is not a substitute. |
| 4 — accounts and usage | in progress | Draft #148 contains real candidate Accounts/Usage panels and CAS/import behavior. Compiled-worker smoke on 2026-09-08 exercised synthetic broker accounts, strict refusal and unchanged legacy state. Those are prototype findings, not a mandate for CLI state or dual stores. Native scoped services, sole state authority and real permitted broker/multiplayer proof remain; #100/#105/#106 stay open. |
| 5 — catalog, suggestions and first use | in progress | Draft #148 connects candidate inspection/routing/suggestion controls; its compiled-worker smoke proves golden routing and missing-catalog reporting for that implementation. Native provisioning/review, authentication and useful first-run recovery must replace CLI-only setup. Full plugin-native acceptance remains under #103. |
| 6 — retire deprecated implementation | not completed | The CLI/TUI, standalone state/registries and engine ceremony still exist in source. #101 now concerns deliberate retirement under the plugin-first design, not a promise of indefinite coexistence or one-for-one terminal parity. Coordinate affected product consumers and authorized data handling without preserving the old application as an architectural constraint. |

Draft #148's final recorded prototype commit is
`381ac912707e1ccc2b6ecbf8f4dcc75c8e99ab17`: Go and plugin gates/CI passed, including
nine plugin behavior tests, real-server dispatch and isolated browser/worker
smokes on 2026-09-08. That evidence applies to its existing implementation only.
The draft remains subject to architectural revision. The broader integration
record is [#102](https://github.com/atyrode/code/issues/102); it no longer requests
a Code publishing service or preservation of a dotfiles launcher wrapper.
