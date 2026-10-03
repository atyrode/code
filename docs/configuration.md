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
| Catalog authoring     | `stageCatalog`, `reviewCatalog`, `promoteCatalog`                             |
| Pure OMP input policy | `composeProbe`, `draftInventory`, `deriveCatalog`, `composeSession`           |
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
configures the OMP gateway or broker. The main view has no Suggest control and no
task text to classify; the `suggest` door and Setup's classifier configuration
remain for callers.

## Bundled starter and model verification

OMP's passive `readModelCatalog({ providers })` returns a versioned bundled SDK
snapshot with `revision`, `ompVersion`, complete model identities and `quotaTier`.
It reads no credentials, provider endpoint, machine inventory or runtime resource.
Code's `readStarterCatalog()` workflow requests the exact `anthropic`, `deepseek`
and `openai-codex` providers. Ordinary eligible models retain their declared costs,
context, image support and thinking levels; special, Spark and unknown quota
classes are excluded. Unmeasured performance stays null. Derivation admits at
most 256 budget-eligible candidates before constructing ladders; it never truncates.

Only a successful canonical configuration read establishes an absent revision 0
or an initialized-empty positive revision. Loading and failure are not absence.
The local starter freezes the full metadata snapshot, catalog, selection, base
revision and account-independent configuration digests. Existing active policy
wins, including historical catalogs without recorded registry provenance. A saved
staged catalog is an explicit preview, not an active profile or a bundled fallback.
An unresolved catalog keeps Models repair reachable; the main view then says the
model list is unavailable, with Retry and Models.

The starter is render-only. Nothing writes it as the workspace's catalog except a
model verification, `workflow.verifyModels(target, { expectedRevision, budget })`:
the one way a Code catalog comes to name models, because only a probe shows which
this operator can call. Preparing reads the workspace at `expectedRevision`
(initializing an absent one), runs OMP's inventory with the pool Code composes from
the saved account choices, and returns the charge, the number of tiny benchmark
requests per provider, having probed and spent nothing. Only the returned `confirm`
spends: one benchmark job per provider, then derive, stage, review, promote and save
the selection narrowed to what the verified catalog hosts. Every step re-observes the
revision, the exact account pool and OMP defaults, and stops, naming itself, when one
moved, on a refusal or on cancellation. A stop never undoes: probe jobs stay in OMP's
history and a staged catalog stays staged. A confirmation is used once, and a failed
or uncertain one is never replayed. The promoted catalog records its verification
provenance (OMP version, inventory and benchmark times, the account providers and a
digest of the exact account pool). A catalog stops being verified when OMP serves
another model list or the saved choices select another pool.

A stale or failed save is never retried or rebased. The local draft remains
exportable until explicitly discarded. Skills and automation (the session options)
are independent ephemeral launch choices, never part of the saved profile. The main
view has no task: it opens an interactive session and the task is typed there, so
its launch review carries an empty prompt. Headless callers still pass a prompt.

## Workbench presentation

The main view reads top to bottom: the **statement**, the **seat board**, the
**earlier statements** and a footer. Accounts, Models and Setup open as sheets over
it, from the footer or from a status fix; Esc or **Back to Code** returns, restoring
focus and scroll position. Visited sheets stay mounted, so profile, catalog, account
and session-option drafts survive moving between them and the empty-to-active
transition. Opening a sheet grants no permission and starts no inventory, benchmark
or session. Blocked, offline, read-only, stale/conflict and failed-observation
status stays visible, with full error detail reachable deliberately.

### The statement

The statement is a verb and six words: lane, tier, thinking, advisor, extras and
machine. Thinking, advisor and machine read after a connector ("thinking high", "on
Studio"). The machine is the destination, not part of the team. Advisor adds its real
role only when selected. Each word changes in place. In the wide forms the first row's
lane, tier and thinking show their neighbouring values as smaller ghosts, and pressing
one chooses it. Pressing a word, or Enter or Space on it, opens its options below the
line, inside the panel and never over the verb; up is more. Extras is a list of
switches, kept open while they are turned. The width form is chosen by measuring the
words in the panel's own font: the whole statement on one line, two rows, the verb on
its own row above pairs of words, or one word per row. A form changes back only once a
wider one fits with room to spare, so a scrollbar appearing does not flip it.

Pointing at or focusing an option or a status fix writes in the two
status lines below the words what choosing it would do (which roles rise, fall, change
provider, appear or go, and how the estimates shift), and the seat board draws the same
team as moves without choosing it. An option that cannot be chosen is shown unavailable
with its reason.

**Quota at the point of choice.** An option carries a hatched redline mark, and its
status line says it, only where choosing it is the cause: it would leave without a
route a role that has one now (its lead's pool is blocked, maxed or has no included
account, and no fallback serves it), or it would lead on a blocked, maxed, tight or
unserved pool that the current team does not already lead on. A pool the team already
strains marks no option, since nearly every option keeps it and that says nothing about
any one. An option that gives roles a route again says so. Choosing a stranding option
is not refused; the status line and the live
region name the roles that would have no route. Quota comes from the same pools and
role outcomes the seat board draws. The status lines are written in this precedence:
a verification running or its charge, a step in flight, the pointed option, team or
fix, the verb's refusal and its fix, a review that differs from what was shown, a
failure, the last outcome, a verification still to do, roles with no route and the one
change of a word that routes them, and at rest where the team's roles lead ("7 on Codex · 6 on
Claude"), whether any reading is not current, the press's scope, pools that are out or
tight and the reviewed pool.

**The verb.** One control whose `data-state` is `ready`, `busy`, `waiting` (a charge
waits on its own Confirm) or `refused`. It is `aria-disabled` rather than disabled and
stays focusable, so a step changing its state never drops focus; pressing a refused one
announces the reason, and the status lines give the reason with a one-press fix where
there is one (use another online machine, show the accounts, review a staged catalog in
Models, retry a read, enable discovery or sessions in Setup, use the saved workspace
team). A read-only workspace is stated in neutral grey: "Read-only workspace · changes
stay a local preview". The label names the next step: **Verify models**, **Review**,
**Save & review**, **Save & launch**, **Launch** or **Launch anyway** (some role has no
route now), with **Checking…**, **Verifying…**, **Saving…**, **Reviewing…**,
**Launching…** and **Resuming…** while one runs. An edited team saves first. **Save &
launch** is offered when the projection rests on present readings (every lead's pool
judged fresh and the served providers known), and the press then continues from the
review to the launch only if the review shows the projected leads and the same
providers in the account pool; otherwise it stops with "Stopped: the review differs
from what was shown", and the next press launches with the reviewed pool. **Save &
review** stops at the review so the pool is seen first.

**Verification and its charge.** **Verify models** runs OMP's inventory ("Checking
which models your accounts can reach"), then states the charge: "Verifying spends N tiny
requests", per provider, "nothing is spent until you confirm", with **Confirm charge**
and cancel. A charge of nothing says "Nothing to verify through these accounts" and
cannot be confirmed. Confirm is the next Tab stop after the verb, is never focused for
the person, and spends only the very charge it showed: never one of zero requests,
never before the Verify press has stayed in its checking state for 700 ms, and only on
a deliberate single press, never the second click of a double-click or a held key.
Progress reads "N of M requests". A verification that stopped or was cancelled says so
until the next one starts; Verify models again is its retry.

Once the saved, verified team meets every launch precondition and its review inputs
(options, accounts, revisions, destination) have held still briefly, the workbench
requests the launch review itself, so Launch is one press. It never does so for an
unsaved edit, a starter or a staged catalog, and at most once per review scope: a
refused review or launch waits for an explicit Review or a changed input.

One gate decides every action: the verb, saving, verifying, confirming the charge,
resuming with or without the team, opening a running session, and every edit of the
team (including a recalled team), the machine or the account pool. Nothing starts while
a step runs, and only Confirm while a charge waits; edits wait too, shown unavailable
in place (a word stays reachable by arrow keys but leaves the Tab order). A chain asks
the gate again before each later step (save, then review once the save is observed;
prepare, then open the terminal), so a team, machine, pool or authority change
mid-flight stops it with the reason. Review and launch refuse only a lead no included
account serves, as the session door does; fallbacks it would drop are noted, never a
refusal. Outcome and refusal lines clear whenever the team, machine or account pool
changes.

**Keys** act only from inside the panel, and keys Code consumes do not reach
workspace-wide bindings. The panel takes focus when it opens, so they work at once.
`Mod+↵` takes the verb's step from anywhere in the panel, typing included, but never
on key repeat. Outside text fields and dialogs: `←` and `→` move between the verb and
the words in reading order; on a word `↑` and `↓` change it (up is more), `Home` and
`End` jump to its ends, `↵` or `Space` open and close its options, `Backspace` returns
it to the last launch (the machine is not recorded) and `Esc` closes the options
without undoing anything. On extras `↑` and `↓` move through the open switches and
`Space` turns the one under the cursor. `1`–`9` recall the recent team with that
number, `r` reads accounts, usage, machines and the workspace team again, and `?` shows
the keys. On a pool head `↵` opens and closes its accounts, `Space` includes or excludes
the focused account and `Esc` closes them. The mouse wheel turns a word only when it is
open, or when the keyboard focused it and the pointer has rested on it for 300 ms
(focus from a click never counts, so the wheel over a just-clicked word scrolls), and
only while the whole panel has been still for 300 ms, with no scrolling and no wheel
left to scroll anywhere in it; otherwise it scrolls. One polite live region announces
outcomes, failures, the charge, recalls and the reason a pressed refused control gave.

### The seat board

Under the statement, provider columns headed by their quota pools, with tier rows of
model seats and each role on the seat that leads it. From 560 px of panel width the
board is columns by tier rows; below it is a roster grouped by provider that says a
pointed team as before → after ("default, task sol → astra"). Both draw one model.
Quota comes only from the pools and role outcomes, seats only from the seat model, and
both are recomputed when the catalog, the team or the reading changes.

A **pool head** is one line (provider, `×included` or `×included of total` accounts and
the verdict), a track per reported quota window with one number (the highest present
reading among included accounts, `–` when none is present), and one note line: the
pressing reset, a pace forecast ("full ≈ 14:20 at this pace", a projection from one
reading) and readings too old to judge. The verdict reads room, "N of M with room",
tight, "blocked" or "maxed" until the reset time or "reset unknown", "none included" or
"no account". Historical readings are said in neutral grey as "<age> old ·
availability unknown", never as room. Accounts not yet read, or unavailable, are said
once for the board ("accounts not read yet · capacity unknown, not zero"). A pool
without windows shows its balance, or that no quota is reported.

A **seat** shows the model, its roles grouped by thinking level and what each meets:
"→ model until 14:20" when its lead's pool is out and a fallback takes over, "no route
until 14:20" (or "reset unknown"), "no <provider> account" when no included account
serves its lead, its fallback chain ("then A › B"), and fallbacks the session would
drop because no included account serves their provider. A model whose quota is metered
apart says its own state. A provider with no seated role collapses to its pool head and
one line of idle seats. Providers with balances that this catalog does not use are
listed as "not in this catalog".

Pressing a pool head opens its accounts in place: the Manual pool and each preset, then
each account with an in/out switch and its readings. Switches edit the saved choices
through `changeAccounts` at the observed revision, one edit at a time, never retried.
They wait while a step runs or a charge waits, are unavailable in a read-only workspace,
and refuse to include an account while the account list is historical or its credential
is disabled. While a preset is active, accounts change only by choosing another pool,
because hand edits belong to Manual. A failed edit is said once beside the accounts.

### Earlier statements

Below the board, two groups, each said only where it differs from the statement.

**Sessions.** Running sessions (terminals that carry an OMP session reference on their
own machine) are listed with **Open**. Saved sessions appear only after an explicit
read of each permitted online machine (**Read <machine>**; failed reads offer **Read
again**; offline machines are named once): the newest five, then **Show all**. A saved
session has **Resume** and **Resume with this team**. Rows say no more than the title,
else the folder, the machine and when; the note says "team not recorded" because no
session records the team it ran with. Every row verb asks the one gate for its own
session before it is pressed and again between its steps. A refused verb stays
focusable and gives its reason, including that a saved session on another machine
waits until that machine is chosen on the statement, since resuming runs on the
statement's machine, and that a read-only workspace allows Open only.

**Recent teams.** Each successful launch records its team in this browser's local
storage per principal and workspace (newest first, one entry per team, nine at most).
The list is device-local, never shared, and grants nothing; it does not record the
machine. A team keeps its digit for the panel's life: relaunching it keeps the digit, a
new team takes the next free one. A row says only the words that differ from the
statement, or "this team". Pressing it, or its digit, recalls the team through the edit
gate; it launches nothing, and recalling the saved workspace team is a discard, not a
local edit that happens to match. When the statement is the saved workspace team and no
recent team says it already, the group says "Workspace team · saved <time> by <name>".

### The footer and session options

The footer says where the facts come from: "models verified <time>" (the last
benchmark), "accounts updated <age>" and, when a staged catalog waits beside the active
one, "a staged catalog waits in Models"; then the links refresh, Accounts, Models,
Setup and keys `?`. **Session options** is a quiet verb beside the first status line
("session options · restricted", "· skills off" or "· N skills" when set). It opens
Automation and Optional skills for the next launch or resume only: the workspace team
stays as it is, the restrictions are not an OS or network sandbox, and a successful
launch or resume clears them. Their closed summary retains restricted tool counts,
skill selections or explicit disable-all.

Setup is optional runtime management: connection status, independent machine
capabilities, folder preparation and the external suggestion classifier, and, under
Profile & source details, the displayed catalog's source, the destination and the
last verification's excluded models. Models leads with authoring/discovery; the editor
reveals pricing, performance, limits and thinking metadata independently.
Editing/import needs no runtime or account setup. Manual catalog authoring retains its
explicit first-save initialization, staging, owner review and separate exact-reviewed
promotion. It is an advanced alternative, not a prerequisite for the bundled starter.
A competing initialization preserves the local draft and refuses a stale first save
instead of rebasing absence. Charge-bearing measurement keeps its warning beside the
action. Destination changes still invalidate native reviews and clear
destination-specific session choices.

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

The same door also accepts OMP's exported `isolation` option,
`{ mode: "material-only", file, sha256, bytes }`. Code carries it through
native review and requires that review to name OMP's `atyrode.omp.material-session`
operation with the identical isolation. It also requires the posted job to run
that operation with exactly the caller's bound inputs. Retained receipts keep
the isolation. Read and follow refuse a retained session whose operation or
bound inputs no longer match it, and cancel still requires the retained
operation and job identity. Requests without isolation keep
their ordinary review operation and the `atyrode.omp.session` job, and neither
placement substitutes for the other. Code never opens or checks the material itself: the
single sealed `material` binding, its size, digest and encoding, the empty tool
registry and the output-only session lease are OMP's native boundary. OMP also
refuses terminal or harness preparation from an isolated review.

A caller that must be able to retry a posting passes OMP's `postingKey`
(`PostingKeySchema`: one to 128 of `A–Z a–z 0–9 . _ : -`, starting with a letter
or digit), such as its own run id. OMP derives the job id from the key, the
caller and the target, so a key names at most one posted session.

A keyed call is answered first, from the target and the key alone, through
OMP's `adoptSession`. Code composes nothing, observes no accounts, reads no
defaults and asks for no review, so a retry or an adoption still finds a posted
session after the profile revision, account choices, defaults or review
changed. Code returns the job only when its own record for that job is this
caller's and matches it; a record for another caller or another job refuses
`code_session_conflict`, and a job Code never composed refuses
`code_session_unknown`. Only a key that has posted nothing composes, reviews and
posts as any call does, under the key.

Before that post, Code retains what it composed as the key's intent, and only
the first intent retained for a key is ever posted under it: a later caller
never replaces it. A caller whose composition, review and inputs equal that
intent continues it, so a call interrupted after Code retained its intent but
before OMP received anything is finished by the next identical keyed call, and
two identical racing calls are one posting at OMP. A caller that composed
something else returns what the key posted, or refuses `code_session_conflict`;
`adoptOnly` then settles the key. A posting whose record after the post never
landed is completed from the intent on the next keyed call.

`listProfiles` remembers each workspace's last posted destination through a
`destinations/<containerDigest>` pointer containing `machineId`, `postedAt` and
`jobId`. Direct posts and adopted or rebuilt receipts advance it only for a
strictly newer retained timestamp, using exact CAS with at most eight attempts;
contention leaves the winning pointer in place. An absent or unreadable pointer
is ignored by reads and rebuilt from the newest retained receipt by the next
post, including pre-existing receipts. Reads use one pointer lookup, scan the
receipts only while no valid pointer exists, and never write. Maintaining the
pointer never fails a post whose receipt already committed. This derived index
is not a saved launch default or authority; receipt retention, action contracts
and configuration data versions are unchanged.

`adoptOnly: true` never composes, reviews or posts: it retires the key at OMP
(`adoptSession` with `retire: true`) and returns the key's session, or refuses:

- `code_omp_posting_unknown` when the key has posted nothing. The answer is
  final: the key can never post afterwards, and a later keyed call refuses
  `code_posting_retired`, as does a create whose post a retire overtook.
- `code_omp_posting_pending` when OMP retained the posting but the hub has not
  received it. The retire executes nothing; ask again.

`adoptOnly` without a key refuses `code_posting_key_required`. Other OMP
refusals keep their names: `code_omp_posting_key_conflict`, and
`code_omp_posting_key_agent_tools_unsupported` for a key with `agentTools`.

`atyrode.code.followSession({ containerId, jobId })` uses the retained session's
exact native target. It returns cumulative inference usage, latest retained
progress and bounded inference-call metadata, with sequence gaps explicit.
It reads settled activity from OMP's durable journal and excludes output bytes,
prompts and transcript bodies. Missing progress is not evidence that a model
has started; an evicted call list is not a substitute for cumulative usage.

### Existing-Run tools for one shot

`atyrode.code.runSession` optionally accepts `agentTools: { runId }`, using
OMP's exported `AgentToolsSelectionSchema` through its session input schema.
The Run must already be authorized by Manifold. This is an explicit selection,
not a grant, policy acknowledgment, credential, actor choice or caller-defined
tool schema. Code cannot create or broaden that authority; native review,
admission and tool execution remain OMP/Manifold-owned.

Omission keeps native tools off. The selector is ephemeral and one-shot-only:
it is not a Code profile/default, terminal workflow option, resume option or
interactive/harness preparation setting. Native review refuses combinations
with restricted automation, material-only isolation or plan-yolo. Selecting a Run does not disable
ordinary skill/project discovery; skills and retained history never grant
tool authority.

Code re-observes composition, account choices and defaults before posting.
The selected native review must name `atyrode.omp.session` and retain the
exact selector; an unselected review still names `atyrode.omp.launch`.
The admitted job must carry the selected Run as `agentRunId`. Code retains
the selector with its session provenance and refuses dropped, changed or
unsolicited correlation on posting, receipt reads, activity reads and
cancellation answers. `agentRunId` is correlation, not a credential.
Existing records without a selector remain unbound; they do not inherit
authority from later history. The existing material, skill, limit and
workspace fences still apply.

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

`workflow.reviewSession(target, expectedRevision, prompt, { skills?, automation?, inferenceLimits?, isolation? })`
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

The session options popover presents available and selected metadata, deliberate sets and
conflict reasons. Choices are local to the pending launch or resume: unrelated navigation
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
The earlier statements request each permitted online machine explicitly (a **Read**
control per machine) and distinguish pending,
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

The earlier statements offer separate **Resume** (saved state) and **Resume with this
team** actions on a listed saved session, and **Open** on a running one. Session
options chosen in the popover apply to the resume. Resume with this team needs the
saved, verified, reviewed team and a lead some included account serves; local
unsaved edits cannot be resumed as a team, and a team that approves plans
automatically refuses. The workflow refreshes
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

The Accounts sheet's ledger uses inclusion checkboxes for exact full identities or
API-key slots; each pool head on the main view offers the same inclusion as in/out
switches over the same Manual and preset pools and the same `changeAccounts` edit.
Same-email OAuth organizations are distinct choices. Manual changes save
immediately; Edit pool creates a local preset draft, and creating a preset does
not activate it. A preset named “Manual” is still a saved preset. Excluding an
account is not disabling its native credential; credential actions and sign-in
remain explicit OMP handoffs.

Usage lists reported windows per account, never an average across incompatible
windows or providers. Missing capacity has no fabricated meter. Failed reads keep
the last permitted facts visibly historical, including blocks, reset deadlines,
balance and credits; none proves current availability. Detailed account facts open in
place under each pool head, and the Accounts sheet keeps the complete ledger. Exact selections omit providers
with no selected account and refuse unresolved saved exclusions.

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
The editor retains the last fresh source observation while a saved manual or
inactive-preset exclusion still references it, even across unavailable readings
and multiple later scope changes. Recovery remains an explicit all-exclusions
review, never an automatic credential or ownership transfer.

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
