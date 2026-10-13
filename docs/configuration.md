# Native configuration and workflows

Code is a policy and presentation plugin, not an independently configured
runtime. Manifold owns identity, storage, migrations, grants/consent, native
resources, jobs, locations and terminals. The independent `atyrode.omp` plugin
owns account and usage observations, broker/sign-in custody, gateway policy,
workspace operations, inventory, benchmark, defaults and reviewed sessions.
Code owns catalogs, selections, account-pool choices, suggestions and their
container-scoped compare-and-set, and each person's own model checks and the standing
approval of what checks spend. The
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
an authoritative store. A person's checks and approval are not shared configuration:
they are the caller's own (see the doors below), and a workspace holds a copy of a
check only once it adopts it.

## Code policy doors

All Code actions are `atyrode.code.<name>`:

| Purpose               | Actions                                                                      |
| --------------------- | ---------------------------------------------------------------------------- |
| Configuration         | `readConfiguration`, `initializeConfiguration`, `select`, `changeAccounts`   |
| Catalog authoring     | `stageCatalog`, `reviewCatalog`, `promoteCatalog`, `discardCatalog`           |
| A person's checks     | `readChecks`, `approveChecks`, `adoptCheck`                                   |
| A person's tutorial   | `readTutorial`, `seeTutorial`                                                |
| Pure OMP input policy | `composeProbe`, `draftInventory`, `deriveCatalog`, `composeSession`           |
| External classifier   | `readServiceConfiguration`, `reviewServices`, `configureServices`, `suggest` |

`initializeConfiguration`, `stageCatalog`, `promoteCatalog`, `discardCatalog`, `select`,
`adoptCheck` and `changeAccounts` take `expectedRevision`. A catalog review takes
`{ containerId, expectedRevision, source: "active" | "draft" }` and returns the
exact catalog digest, compiled route/estimate review and `reviewDigest`.
Promotion supplies that digest against the same source and revision. Discarding clears
the staged list at the revision it was seen in and refuses `code_catalog_missing`
when none is staged; the active list, the saved team and the account choices stay as
they are.

A person's model checks and their standing approval are the caller's own, keyed by
their principal and kept only for a person whose sign-in reaches the workspace root
(Code asks `containers:read` there); nobody reads or writes another person's, and an
agent, a service, or a token confined to one container or by an authority ceiling keeps
none. `stageCatalog` with a `verification` also keeps the staged list as the checking
person's check of its exact account pool and the budget it was derived under
(`verification.budget`, required), at `checks/<person>/<budget>/<poolIdentityDigest>`,
unless they already keep one whose benchmark completed no earlier, or another of their
checks of it is kept first; it stays kept whatever then happens to the stage or its
promotion, since it is still a true measurement, and the 16 most recently kept are kept.
Every stored check and approval names its principal, and a read of one naming anyone
else, or filed under another key, refuses `code_invalid_configuration`.
`readChecks({})` answers `{ keeps, revision, approvedRequests, approvedAt, checks }`:
whether the caller keeps checks at all, and each check's pool, budget, list digest,
verification provenance, when it was kept, and every model it ladders as `provider/id`; a
caller that keeps none reads `keeps: false` and none, and the panel then promises no
later check anything when it asks for a charge.
`approveChecks({ expectedRevision, requests })` records, at the approval's exact
revision, the largest charge in benchmark requests the person approved checks to spend
without asking; `requests: 0` withdraws it, a moved revision refuses
`code_stale_preferences`, a caller that is not a person `code_person_required` and a
confined sign-in `code_checks_confined`. Both ask no container capability and are
container-graded, so a token confined to one container reaches them and is answered as
keeping none. `adoptCheck({ containerId, expectedRevision, accounts, poolIdentityDigest,
budget, selection })` puts the caller's check of the workspace's present pool and that
budget in use: Code recomputes the pool from the observation and the saved choices and
refuses `code_accounts_changed` unless it is the one named, refuses `code_check_missing`
when the caller keeps no such check, `code_invalid_provenance` when the kept list names a
provider the pool does not include, and `code_check_current` when the workspace already
holds a list of that pool whose benchmark completed no earlier. It saves `selection`
(else the saved one) narrowed to the check's list, and leaves a staged list as it is.

Whether a person has seen the panel's tutorial is their own record too, kept the same
way at `tutorial/<person>`. `readTutorial({})` answers `{ keeps, seenAt }`: whether the
caller keeps the record at all, and when they first finished, skipped or answered the
tutorial's offer (null before). `seeTutorial({})` records it once and answers the same:
a record already there stands as it is, so two tabs or devices marking it agree. Neither
refuses a caller that keeps none: an agent, a service or a confined sign-in reads and
marks `keeps: false`, and the panel then keeps it in the browser instead. Both ask no
container capability and are container-graded, as the checks' doors are.

`CatalogDocumentSchema` is `{ schemaVersion: 1, models: [...] }`. Each model has
an explicit key, provider/id/API identity, tier, quota bucket, costs,
performance, context, thinking levels and image support. Capabilities are 1–4. Tier 0
was Spark's off-ladder rung and is retired: a stored catalog that still lists a tier-0
model keeps parsing, and the model is never placed or routed. `SelectionSchema` records
lane, capability, thinking, advisor, priority, prewalk, plan-yolo, fallback and budget
(always the domain's default, `any`, in the panel), and still parses a `spark` flag,
which is read as off. Code never recovers these semantics from terminal output.

A family's declared rungs fill its missing tiers 1–3, each gap from the nearest declared
rung (the lower on a tie), so a filled tier routes to a real model of that family; tier 4
is never filled. A lead on a filled tier is that rung's model and routes as it: its
fallbacks step down from the rung's own tier and cross to another family at that tier,
not the one chosen (GPT smart on `terra`, a normal rung, crosses to Claude's normal). A
family Code requires (OpenAI, Anthropic) fills the same way: one that lacks a rung of its
own at tier 1, 2 or 3 is **short**, and the compiled catalog names it (`short`) rather
than refusing it.

Known providers may add named families, quota metadata, priority
or off-peak behavior. A provider without such a policy is still a complete
provider family: its exact provider identifier is the family, its rungs fill missing
tiers like any family's, and Code adds no cross-provider lane,
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
context, image support and thinking levels; any quota class other than chat (Spark's,
for one) is excluded, since Code spends no quota of its own. Unmeasured performance stays null. Derivation admits at
most 256 budget-eligible candidates before constructing ladders; it never truncates.

Each family is laddered fast, normal, smart, elite (tiers 1–4) after keeping only the
newest version of each model name. OpenAI names its tiers, so its ladder is those names:
luna, terra, sol and astra, each at its own tier whatever its price or context window (of
ids sharing a name, the newest takes it), and a model whose id names none of them is not
chosen; a listing with none of the names is laddered as any other family is. Any other
family's cheapest model is its first rung and its most capable its top (the highest thinking
ceiling, then the higher price), with up to two of the most capable models priced between
them, or, where fewer than two lie between, priced as an end, as its middles. A rung that is
not cheaper than a rung below it must reach every thinking level of that rung. A context
window is not a capability: it never ranks a model or refuses a rung, since OpenAI's newer
sol and astra carry smaller windows than the older terra beneath them. A catalog verified
under the earlier context rule keeps its ladder, as stored active policy does, until it is
verified again.

Only a successful canonical configuration read establishes an absent revision 0
or an initialized-empty positive revision. Loading and failure are not absence.
The local starter freezes the full metadata snapshot, catalog, selection, base
revision and account-independent configuration digests. Existing active policy
wins, including historical catalogs without recorded registry provenance. A saved
staged catalog is an explicit preview, not an active profile or a bundled fallback.
An unresolved catalog keeps Models repair reachable; the main view then says the
model list is unavailable, with Retry and Models, whatever else the launch line says.

The starter is render-only. Nothing writes it as the workspace's catalog except a
model verification (the panel's **model check**),
`workflow.verifyModels(target, { expectedRevision, budget, selection, adoptOnly })`: the
one way a Code catalog comes to name models, because only a probe shows which this
operator can call. Preparing reads the workspace at `expectedRevision` (initializing an
absent one). When the caller keeps a check of the workspace's present pool, derived under
`budget`, whose benchmark completed later than that of the list the workspace holds for
that pool, or the workspace holds none for it, preparing puts that check in use
(`adoptCheck`, with `selection` narrowed to it) and ends there, spending nothing:
`{ kind: "adopted", verified }`, whose excluded models are unknown. Otherwise it runs
OMP's inventory with the pool Code composes from the saved account choices and returns
`{ kind: "charge", charge, approvedRequests, confirm }`: the charge, the number of tiny
benchmark requests per provider, and the caller's standing approval as read while
preparing, having probed and spent nothing. An `adoptOnly` run instead ends with
`{ kind: "none" }`, having started and written nothing, and never initializes an absent
workspace. A `beforeWrite` option is awaited before the run first adopts or stages, so a
caller can hold those writes, and a confirmation passed `unasked: true` (nobody pressed
for it) reads the standing approval again before its first benchmark request and stops
with `code_approval_withdrawn` unless it still covers the charge. A catalog routes only its
rungs, so the charge probes every eligible model of a family Code requires (OpenAI,
Anthropic), whose ladder must survive a model that does not answer, and only the
rungs any other family's listing ladders (DeepSeek, OpenRouter, any other provider);
such a rung that does not answer leaves that family shorter. A family Code requires is
laddered on whatever of it answers, short below three rungs, and one none of whose models
answers is left out as a family with no account is; a selection that needs it is refused
where it is reviewed. A model whose probe got no answer the benchmark could read (OMP's
`unresolved` or `unmatched`) is left out rather than discarding every model measured beside
it: as `inconclusive`, or as it would be had it answered where its answer could not change
the list (`superseded` by a newer version that answered, `separate_quota`). `deriveCatalog` returns the document
and every other offered model with its reason; the document's compiled catalog names its
short families. It refuses only a family Code requires whose ladder would put a model above
one that costs no more and thinks deeper (`code_ladder_regression`, naming both), a benchmark
that does not answer the charge exactly, and nothing laddered at all
(`code_probe_insufficient_ladder`). Only the returned `confirm`
spends: one benchmark job per provider, then derive, stage, review, promote and save
the selection narrowed to what the verified catalog hosts. An `inconclusive` model may be
left out only where nothing already chosen needs it. When it is in the list in use as a
verification with this exact account pool made it, or in the caller's own check of that
pool, or belongs to a family the wanted lane names (one provider, or OpenAI and Anthropic
for the mixed lane) that the new list would not have at all, the run stops at derive
(`code_models_unanswered`, naming the models) before the selection is narrowed, with the
list and the saved selection unchanged, since an outage or a rate limit reads the same as
a model the account cannot use. A list verified with other accounts, or never verified,
holds no such claim. Every step re-observes the
revision, the exact account pool, OMP defaults and OMP itself, and stops, naming itself,
when one moved, on a refusal or on cancellation. A stop never undoes: probe jobs stay in
OMP's history and a staged catalog stays staged. A confirmation is used once, and a failed
or uncertain one is never replayed. Staging keeps the list as the checking person's
check of its pool and budget (see the doors above), and the promoted catalog records its verification
provenance: the OMP its inventory ran under, as content identities — the artifact the
inventory job ran from (`inventoryArtifactSha256`) and the revision of OMP's bundled model
catalog when the inventory started (`catalogRevision`), the list the inventory picks its
models from — the inventory's OMP version, inventory and benchmark times, the account
providers and a digest of the exact account pool. A catalog republished while the
inventory runs stops the verification before its charge is answered. A catalog stops
being verified when the saved choices select another pool, or when OMP's bundled catalog
has moved to another revision that no longer publishes a model the profile routes to,
leads and fallbacks; the launch line then says OMP no longer lists a model this profile
uses, and Models names it, or counts several. An OMP update alone leaves the verification current: the
selected destination's inventory operation installed from another artifact
(`describeDestination`'s pins), or another catalog revision that still publishes every
routed model. What OMP publishes is read only once its catalog has moved, since the
revision a verification recorded publishes every model it laddered. Because the identities
are content digests, an update is seen whatever version OMP reports and without a new
Code build, and Models says it beside the verification's date; no version string is
compared. A catalog recorded before verification carried these identities reads as
unverified. An identity not yet observed, or whose read failed, claims no change: the
destination's failure keeps the launch refused, a failed model list read is named in the
launch line with Retry and Models, and a failed read of what a moved catalog publishes names
nothing and leaves a dropped model to the session door, which re-checks that every routed
model is still published (`code_model_unpublished`). A list in use that holds can still be
checked again: a check needs only its own preconditions
(write access, the machine, readable accounts that include one, discovery and benchmark
readiness), and its charge asks unless the person's standing approval covers it. A model that draws a
quota of its own (any OMP class but chat, Spark's for one, as each inventory row states) is
left off the derived ladder and listed among the last verification's excluded models as
`separate_quota` with OMP's class for it (`quotaTier`), since Code spends no such quota.

A stale or failed save is never retried or rebased. An unsaved edit remains
until it is saved or explicitly discarded. It also survives a reload: the main view keeps
an unsaved team in the tab's session storage per principal and workspace, with what
it was made from (base revision and team, the catalog digests, whether choices
existed, and for a first-use draft the bundled model list), never the catalog itself.
After a reload the draft returns only onto that same catalog or list; otherwise it is
dropped without a word. A returned draft is judged like any other: a write that left
its team and catalogs alone moves its base forward, and a foreign team or catalog
write is a conflict. A list this panel stages, puts in use or discards in Models is its
own change, never a conflict: a draft made on the list in use follows a list staged or
discarded beside it, and a first-use draft follows an import's own initialization, so a
stage refused after it leaves the draft resting on that initialization, as a stopped
first verification does. A write that replaces the list a draft was made on (using the
staged list replaces the list in use and the staged one, discarding or importing
replaces the staged one, and an import replaces the bundled list a workspace without
one previews) never drops an unsaved edit. A list put in use brings its own default
team, so no team made on the replaced list carries over; instead Models holds that
write and says which list the edit is on, what the write does to that list and what
each fix does: **save**, for an edit of the team in use, keeps the edit on the list in
use, and **discard edit**, which the import dialog offers too, drops it. Once a staged
list is put in use, the readout says **the profile is the new list's default now** when the
saved team gave way to it. While a Models write is in flight the gate counts it as a step in
progress, so no edit lands before its receipt does. Only an untouched draft gives way
to the record, as the bundled preview does to a list imported into a workspace
without one. A draft
that only repeats the team the view shows without it is not kept. Skills and
automation (the session options) are independent ephemeral
launch choices, never part of the saved profile. The main view has no task: it opens
an interactive session and the task is typed there, so its launch review carries an
empty prompt. Headless callers still pass a prompt.

## Workbench presentation

The main view is one panel. A **top bar** carries the views as tabs (Generator,
Accounts, Sessions) and one **More** menu (Models, Setup, Options, Shortcuts, Tutorial). The
panel reads its inputs again on its own, so it has no Refresh button. The **generator**
holds five rows of plain words, a readout line, the cost and speed meters and the
launch row; **routing** stands beside it and
**usage** under both. The **accounts** and the **sessions** replace that stage while
open, and under the accounts **Manage accounts** opens their management. Models,
Setup and Options open as sheets over the stage, from More, a key or a launch-line
fix; Esc or **Back to Code** returns, restoring focus to what opened the sheet (the
generator's rows when that has gone) and the scroll position. Visited sheets stay
mounted, and so does the accounts' management once opened, so profile, catalog,
session-option and preset drafts survive moving between views and the empty-to-active
transition. Opening a view or a sheet grants no permission and starts no inventory,
benchmark or session. Blocked, offline, read-only, stale/conflict and failed-observation
states stay visible in the launch line, and the exact failure of a destination read is
said in Setup's readout while its OMP row is pointed or focused.

Every action is a visible control; keys are accelerators for them, listed in the
**Shortcuts** dialog by the view they act in. A control names its key in its tooltip and
`aria-keyshortcuts` only where that key does what the control does in the view shown:
the Generator tab names Esc or `a` only from the views where they go back to it, and
Models names `m` only in the generator, where `m` opens Models rather than Manage accounts.

### The top bar

The tabs are a tab list: `←` `→` move among them and `↵` or `Space` opens one. Below
760 px of panel width, when the panel is too short for routing under the generator,
**Routing** and **Usage** join them as views of their own (see the layout below). **More**
keeps to the bar's end and is a standard menu button: a press, `↓`, `↵` or `Space` opens
its menu on the first item and `↑` on the last; `↑` `↓`, `Home` and `End` move, `↵` or
`Space` chooses, and an item's own key (`m`, `u`, `o`, `?`) chooses it too. `Esc` closes
the menu and returns focus to More; `Tab`, a press outside or focus leaving closes it.
Choosing returns focus to More, where a sheet or dialog gives it back. **Models**,
**Setup** and **Options** open their sheets (`m`, `u`, `o` from the main view, where the
menu shows each key beside its item). While a staged model list waits beside the active
one, More reads **More · staged** and its item **Models · staged**, since nothing changes
until it is reviewed there. When session options are set, More and its **Options** item
carry their summary ("· restricted", "· skills off", "· 2 skills"). **Shortcuts** opens a
native modal dialog that lists every key under the view it acts in (Generator, Views,
Accounts, Sessions, Tutorial, Anywhere), with `m`, `u` and `o` under Generator, where they act;
`Esc` or its Close button closes it and it owns its keys while open. **Tutorial** walks the
tutorial again (below).

The workbench reads its inputs again on its own: the workspace profile, OMP's setup,
defaults, bundled model list, skills and accounts, and the machine list, once a minute
while the panel shows and once when it shows again (its page returns or the panel comes
back on screen) unless it read in the last 15 seconds. A minute keeps a panel left open
current within a glance's patience for a handful of small reads, and a hidden panel
reads nothing. Such a read never lands in the middle of something: while a step runs or
a charge waits, a sheet, Shortcuts, a question, More or the machine list is open, a row is being
scrubbed, a text field is in use, an account change is saving, or within four seconds
of a key or a press in the panel, it waits and happens once that is over. An edit left
unsaved holds it however long it is left, focused or not: a changed generator row until
the profile is saved, verified or the change discarded or turned back, and a saved pool
draft under Manage accounts until it is saved or discarded. An untouched first-use
preview is no edit, so first use reads as usual. A failed read is named where it always
is: the launch line, the usage line, the sessions. The usage reading keeps its own
cadence (below). Both cadences are one schedule: reads that come due together share one
pass that reads each observation once, and **Refresh now** (`r`) or opening or closing a
sheet reads everything in one pass and restarts both.

### The tutorial

On a person's first open of the panel, wherever they open it, a question asks "Welcome
to Code" with **Take the tour** and **Skip** (`Esc` and the backdrop skip), once the
generator shows its profile in the main view with no sheet open, nothing running, no
charge waiting and no other question open. It is offered to people only: an agent or a
service is never asked. Either answer marks the tutorial seen for that person
(`seeTutorial`, or the browser for a sign-in that keeps no record), so it is never offered
again; **Tutorial** in More walks it whenever they like. The walk starts on the generator
(a sheet closes and the view goes back to it) and keeps to the steps the panel shows
there, so its count holds when a step opens another view: the profile's rows, the
readout, Defaults and Revert, routing, usage, the machine, the launch, the Accounts and
Sessions tabs, and More. Each step draws a thin ring in the accent around its control and
a card beside it (under it where the panel shows room, else over it), both laid over the
panel so nothing in it moves, and both kept to the part of the panel the window shows: the
step's name, where the walk stands ("3 of 10"), one sentence, and **Next** (**Done** at
the last), **Back** and **Skip**; `→` and `←` step, `Esc` skips, and a held key steps once.
Each step's card is its own, so moving to it moves focus to its Next and it is read out,
and its control is scrolled into view. Routing and usage are pointed at where the layout
puts them: beside the generator, else their tab or Show control. A step may be tried:
choosing a word in the rows, or opening Accounts, goes on by itself once done since the
step began, and Next always works too; Back onto a step another view hides brings the
generator back. The walk launches nothing and spends nothing; a word tried changes the
rows as any choice does, which Revert puts back. A step whose control is not shown (another
view or a sheet has the panel), or any step while a popover of the panel is open (More's
menu, the machine list), hides its card until that changes. The walk's end, finished or
skipped, puts focus on More, where it is replayed, so a second `↵` of a double press opens
a menu rather than launching.

### The generator

Rows run top to bottom: **lead**, **model**, **thinking**, **advisor** and
**fallbacks**. Each is a radio group of its words in order, with one Tab stop, on its
chosen word; the chosen word is bold in its provider's hue (the lane's accent for
thinking and advisor), with a glider under the words and a detent tick under each word
while the row is pointed or focused. A click chooses a word and focuses the row's
value; a drag scrubs along the row and chooses at each detent it passes. A word that
cannot be chosen is struck through and refuses, with its reason in the readout. Priority,
prewalk and auto plans are not rows: they are the **Profile switches** at the head of
the Options sheet, saved with the workspace profile like the rows and refused through
the same gate (priority also needs a GPT lane). The machine is not a row: it is a
dropdown beside the launch (see the launch). Free-only is not a control: the budget
stays the domain's default. The generator's head carries **Defaults**, which returns
every row to the catalog's default, and **Revert**, shown only while the rows hold an
edit of the saved workspace profile, which discards it. Both go through the edit gate,
and the readout says the route changes they made ("no route changes" when none). When
routing or usage is hidden, **Show routing** and **Show usage** stand in this head.

- **Lead** is who leads: **mixed**, then each family the catalog's lanes lead on (GPT,
  Claude, DeepSeek, then any other provider), with an **only** checkbox at the row's end.
  The stored lane is unchanged: `mixed`, or a family's led or only lane; checked means
  only. Changing the lead keeps the box, so GPT only with Claude pressed is Claude only;
  a lead that does not offer that variant, or cannot run it while it can run the other,
  lands on the other, and the readout says so. The box is its own Tab stop (Space
  toggles it); it is disabled for mixed and for a lead with one variant, and struck as
  well when the variant it would select cannot run, with the reason on point or focus.
  A lead is hidden only while its family has no signed-in account at all, unless it is
  the lead in use; with no account signed in anywhere every lead shows. A lead neither of
  whose lanes the included accounts can run stays, struck, with the domain's reason. A
  family someone has signed in for but the model list has no model of keeps its lead,
  struck, with "No <family> models in your model list";
  pressing it checks the models (through the check's own gate, spending nothing before
  its charge's question is approved, unless the person approved checks) and the readout
  says it finds the models the
  accounts reach.
- **Model** is the capability tier (fast, normal, smart, elite), each tier read as the
  model alias its `default` role would lead on in the profile that choosing it forms,
  with the tier's word under the alias, so a tier a short family fills reads as the real
  rung it routes to (smart reading `terra` beside normal's `terra`). A tier no model fills
  reads as its word alone, refused. A curated catalog's own keys (`sol`, `opus`) are its
  aliases. A derived key (`provider.id`) is named by the last id segment that is not a
  version or qualifier (`gpt-5.6-sol` is `sol`, `claude-haiku-4-5` is `haiku`); models
  whose aliases collide keep their full ids, since two models wearing one name would
  misreport the route.
- **Thinking** and **advisor** are levels whose fill grows from the first word; `off`
  is drawn quietly. Advisor adds its real role only when selected.
- **Fallbacks** is two words, on then off. The chosen one says what it means; the other
  says what turning it does. `Space` flips it.

One **readout** line under the rows says what is pointed or focused: the value in bold,
then what it means or what choosing it does (which roles rise, fall, change provider,
appear or go, and how the estimates shift), warm when it refuses or strains. Its
precedence is a scrub in progress (the whole change from where it began), then what
the last key or press did, kept about 2.6 s, then the pointed word, then the focused
row.

**Quota at the point of choice.** A word's readout says, in the warm tone, where
choosing it is the cause: it would leave without a route a role that has one now (its
lead's pool is blocked, maxed or has no included account, and no fallback serves it),
or it would lead on a blocked, maxed, tight or unserved pool that the current team does
not already lead on. A pool the team already strains marks no word, since nearly every
word keeps it and that says nothing about any one. A word that gives roles a route
again says so. Choosing a stranding word is not refused; the readout and the live
region name the roles that would have no route. Quota comes from the same pools and
role outcomes the routing pane draws. Spark is retired: there is no Spark row, route
or quota bucket, and a stored selection with the Spark flag reads as off.

### Routing, cost and speed

The **routing** pane lists every role on one line: `●` for a role an agent backs, the
role, and its lead as `model:thinking` in the provider's hue, with the advisor's line
held while it is off so turning it on adds a value rather than a line. A change rolls
each value that moves and flashes its row, top to bottom; a launch lights the rows in
turn. A lead that quota leaves out (its pool blocked, maxed or served by no included
account) is struck and says why under the pointer ("Claude blocked until 16:55 ·
falls back to sol:high", or "no route"); any pointed value names its exact
`provider/id` and thinking level. A role name too long for its room ends in an ellipsis
and says itself whole in its title; under 300 px each chain goes under its role. Routes
come from the review on display: a held review's composition while it stands (see the
launch below), else the local review.

The **fallback chains** checkbox in routing's head (`f`) shows the chains behind each
lead (`lead → fallback → fallback`) while the profile's fallbacks are on. With fallbacks
off the checkbox is refused, and a press (or `f` in the main view) takes focus to the
fallbacks row and says there are no chains to show. Its state is local to the open
panel. **Hide** in routing's head (`p`) removes the pane; **Show routing** in the
generator's head brings it back.

Whenever routing is not shown with the generator (hidden, or a tab of its own in a short
narrow panel) the profile shows under the rows grouped by what it runs: each group's
`model:thinking`, then its roles in routing order with `●` on agent-backed ones. Groups
read by provider, the default role's first and then GPT, Claude, DeepSeek and the rest.
Within a provider they read by level: the higher tier first (elite, smart, normal, fast),
then the higher thinking, and last by alias, so equal levels always stand in one order. A
change that moves a role between groups glides it there.

The **cost** and **speed** meters sit above the launch: five glyphs each (`$` and `»`),
lit to the level in the lane's accent, and the level's word while pointed. Cost is a
role-weighted relative list-price index, lowest to highest, not billing; subscriptions
spend quota windows, which usage shows. Speed comes from measured throughput and
first-token time, and only when every lead model has them: otherwise its glyphs stay
unlit and the readout says "unmeasured · a model check measures it", rather than
showing the index's middle level.

### The launch

The launch row reads `↵ <step> on <machine ▾>`: the **launch** button, the machine
dropdown, and the **launch line** (below) beside them. The launch row follows the
generator's rows, and the launch line sits beside the launch, or under it when it has no
room beside it, and grows downward, so the launch never moves under the pointer while its
line changes. The step is the label of the next step in lower case: **launch**,
**save & launch**, **save**, **launch anyway** or **review in Models**, and **checking
models…**, **saving…**, **launching…**, **resuming…** or **working…** while one runs.
There is no separate verify step: when the list in use cannot serve a launch, the launch
checks the models first. There is no review step either: a launch reviews its session
inside the press (below), and nothing reviews without a press, so no review ever changes
the label.

**The machine.** The dropdown shows the machine's name, a neutral dot that shows
whether it is online and a chevron. It opens a list of the machine roster above the
launch row; click, or `w`, opens it with focus in the list. `↑` `↓`, `Home`, `End` and
`↵` or `Space` choose; `Esc`, `Tab` or a press outside closes it and returns focus to
the dropdown. While open the list owns its keys, so the panel's keys do nothing.
Choosing goes through the edit-machine gate: while a step runs or a charge waits the
dropdown refuses with the gate's reason, as a locked row does. An offline or
access-revoked machine is struck and refuses with its reason, and so is a machine OMP
is not installed on ("no OMP here"),
which can run nothing. Code checks every online machine for OMP, and a browser starts
on the destination it saved in the tab if OMP answers there, else on the first online
machine where it does; with none, the saved one or the first online machine stays
chosen so the launch line can say why nothing runs there, and nothing is chosen before
every online machine has answered. The readout says what the pointed machine is
("online", or why it cannot be chosen). The machine is the destination, not part of
the team, and is not recorded in recent profiles.

**The verb.** The launch is one control whose `data-state` is `ready`, `busy`,
`waiting` (a check's charge waits on its dialog) or `refused`. It is `aria-disabled`
rather than disabled and stays focusable, so a step changing its state never drops
focus, and a launch-line control that leaves once pressed hands focus to the launch;
pressing a refused one asks its question (below), and pressing it while a step runs
shakes it, says why in the readout and announces it. A
read-only workspace (no `containers:write`) is stated in neutral grey, "Read-only
workspace" (its readout adds "changes stay a local preview"). Write access is the caps
alone: without a canvas beside the panel, checking models, saving and account edits still
work, and only launch and resume refuse, in neutral grey, "Open Code beside the
workspace canvas to launch". **Launch anyway** is offered when a role's pools are out,
never for a lead no included account serves, which save and launch both refuse.
**Review in Models** opens Models for a staged-only workspace. A launch that must check
first is refused up front when the account observation cannot be read or includes no
account. An edited
team saves first; while the launch is pointed or pressed the readout says what the save
changes ("2 changes to the profile: thinking high → max, advisor glance → off"), and
**Revert** discards the edit. **Save & launch** saves, then launches once the saved
revision is observed (only **Save** where no canvas can place a terminal).

**One press.** A launch reviews the saved team's session on the destination immediately
before it starts it, in the same press (**launching…** throughout), and starts it when
the review shows what the panel showed: the same lead for every role and the same
providers in the account pool. A review that differs stops the press and is held, and its
question asks "What will run differs" with what differs (roles' leads, providers that
joined or left the pool, or that the accounts were not known before), **Launch it** and
**Not now**; while the launch is pointed the readout says where it runs and its pool
("runs on <machine>: GPT 2"). **Launch it** is the launch's own press and launches the held
review while the press's own inputs hold (team, options, machine, the saved profile and
authority), a selected skill catalog's revision is the one it was made with, the reads it
rests on succeed and its launch is still the step (the list in use serves it); **Not now**,
a moment when the launch cannot go on (a machine gone offline, a check writing the model
list), or the first of them that fails drops it for good, and the press after that reviews again.
Accounts or OMP defaults that moved after it are refused by the launch's own check (below). A press
stands on the same inputs: a change of one of them while it runs stops it, while an
observation that moves meanwhile does not, since the launch reads the accounts and
OMP's defaults again itself and refuses when they moved under its review. Choosing a
saved session does not stop a launch. Outcome and refusal lines clear whenever the team,
machine or account pool changes.

**Questions and notices.** Whatever a press waits on the person for is asked in a modal
dialog over the whole page rather than said beside the launch, so it cannot be missed: a
check's charge (from the launch, Models or a struck lane), a review that differs, a check
that changed the profile, and a refused Launch press. Each question says what it waits on
and, where it can, why in a sentence, what it is about one fact per line, then its choices
as words, the next action first in the accent, and a way out last (**Cancel**, **Not now**
or **Close**), which never spends or launches. A refused press's question names the
refusal (as the launch line's head below, an account read's failure in its sentence), says
why it applies ("Launch opens a terminal on a machine. Choose one that is online.") and
offers the fixes the line offers for that refusal before **Close**; a fix runs and closes
it, and a refusal that lifts or changes, even to another reason of its kind, closes it too.
A check that changed the profile is asked when it happens or never: a launch that cannot go
on then drops it for good, as a held review is dropped. A question opens with focus on its
title, never on a choice, since a charge or a review comes back while the person may be
typing elsewhere: `Tab` reaches the choices, the next action first. No press answers it in
the 400 ms after it opens or its question changes, and a key answers with a choice only once
that choice has held focus for 300 ms, so `Tab` then `↵` in one burst answers nothing;
neither does the second click of a double click or a held key. `Esc`, a press that starts
and ends on the backdrop, and a close the browser forces take the way out at any time.
Closing gives focus back to what had it. Reads on their own wait while a question is open.
How a press ended is also posted to Manifold's one notice stack, which shows it at the foot
of the page, each outcome replacing the last: "Launched on <machine>. Type your task in its
terminal.", "Resumed on <machine>.", a save, a failed step in its words, and a check the
person started that stopped. A check cancelled by the person, or run by the panel on its
own, posts nothing.

**Live dials.** An agent launch (see the workflow below) ends "Launched on <machine> ·
**dials**", the fix opening Sessions (`e`); a launch the reviewed session carried ends
"Launched on <machine> · no live dials: <reason>" (auto plans are on, session options
are set, not enabled on <machine> with **Enable in Setup**, your access sponsors no
agents here, agents unread). While the launch is pointed with a held review, the readout
says the same ("live dials in Sessions" or the reason). Setup's sessions row, and the
"Open coding sessions" review, enable OMP's launch and harness operations together.

**The launch line** sits beside the launch, or under it where there is no room beside
it, and keeps to facts and one-press fixes, each
a button; its asides ("changes stay a local preview", "checking models in the
background", and, while a staged model list waits beside the active one, "a staged model
list waits in Models") are said in the readout while the launch is pointed or pressed. It
is written in this precedence: a check the person started (or one the launch waits on)
running, or "Waiting for your approval" while its charge's question is open, a step in
flight, the verb's refusal with its fix, a staged model list the verb opens, a failure,
the last outcome, and roles with no route with the one change that routes them (said
once no check precedes the launch). What a press waits on the person for is asked in its
question, never in the line. A model list that
cannot be read joins the line from the verb's refusal on, with its Retry and Models.
The line names what failed rather than a general refusal:

- **Accounts.** "Accounts unreadable: <reason>" with **Retry** when the read failed;
  "Account list not current" with **Refresh**; "Saved account choices no longer match
  your accounts" with **Show accounts**. The account observation is read every second,
  so one failed read is not a fact about the accounts: for 15 seconds the gate keeps
  judging the last good observation, and every effect reads the accounts again itself
  before it starts. "No account is included" and "No <family> account included" offer
  **Show accounts** (`a`) and, where one exists, **Use <lane>** for the nearest lane the
  accounts serve.
- **Workspace profile.** "Workspace profile unreadable" when its read failed, "The
  workspace profile needs a fresh read" when it is only older than its last write, each
  with **Retry**; "The workspace profile changed elsewhere" with **Use theirs**.
- **OMP.** "OMP isn't on <machine>" when the destination refuses OMP's actions
  outright, in place of the readiness and permission refusals it would otherwise cause,
  with **Use <machine>** for another online machine where OMP answers. "Model checks
  unknown on <machine>" is kept for a read that really failed.
- **Machine.** "<machine> is offline", "access revoked", "is unavailable", "The chosen
  machine is not in your machine list" or "Machine list unreadable", each with **Use
  <machine>** or **Retry** where one applies.
- **Models and setup.** "A staged model list waits in Models" (**Review in Models**),
  "No model list in use" and "These choices need a model review" (**Open Models**),
  "Discovery is not enabled", "Sessions not enabled on <machine>" and "Sessions
  unavailable on <machine>" (**Enable in Setup** or **Open Setup**), and "Skill choices
  need attention" (**Open options**).

A fix that opens a place answers to that place's key too.

**Model checks and their charge.** A launch needs a model list checked against the
account pool (see the starter and verification above). The list in use serves a launch
when its check holds, or when it passed one and only the accounts changed since without
leaving a lead no included account serves; a background check then renews it while
the launch stays ready (below). Otherwise (no list yet, an imported list, a routed model
OMP no longer lists, or a lead the changed accounts no longer serve) the step is a check
the launch runs first, under the **launch** (or **save & launch** when the rows hold an
edit) label, and the status sentence says why: "Launch first checks which models your
accounts can use.", "Accounts changed since the models were checked; Launch checks them
again first." or "OMP no longer lists a model this profile uses; Launch checks the models
again first." The press reads **checking models…**: it puts the person's own newer
check of the pool in use when they keep one, spending nothing, or runs OMP's inventory
("Checking which models your accounts can use") and answers the charge. A charge the
person's standing approval covers (up to twice the largest charge they approved) is spent
at once; any other is asked: "Check your models first" (from Models, "Check your models"),
why ("Launch needs to know which models your accounts can use, so Code sends each one a
tiny request."), the charge ("29 tiny requests: GPT 8 · Claude 19 · DeepSeek 2", in the
panel's family order), and, for a person who keeps checks, "You approve this once. Later
checks run on their own."; then **Approve and launch** (**Approve** from Models) and
**Cancel**. A charge of nothing asks "Nothing to check" with **Show accounts** and
**Close**, and cannot be approved; every way out of a charge cancels the check, spending
nothing. Approve is never focused for the person, and spends only the very charge it
showed: never one of zero requests, never before the press has stayed in its checking
state for 700 ms, and only on a deliberate single press, never the second click of a
double-click or a held key. It records the standing approval (the larger of the one held
and this charge) before spending; one that cannot be recorded still spends this charge,
and the next check asks again. Progress reads "Checking models with your accounts · N of
M requests". When the check is done the press goes on to the launch, which reviews and
starts the saved team as above, unless the check narrowed a setting of the profile it was
pressed on, which stops the press and asks "The model check changed your profile" with the
settings it moved, **Launch** and **Not now**. A check that stopped or was cancelled says
so ("Model check stopped while <step>: <reason>", "Model check cancelled") until the next
one starts; the launch is its retry.

**Background checks.** The panel starts a check on its own when the workspace has been
set up, the list in use no longer holds, no staged list waits, the list in use is not an
imported one, the rows hold no edit, nothing else is in flight and a check could run
here, and either the person keeps a newer check of the pool and budget to adopt, or the
list passed a check and the person approved checks. A workspace never set up is left to
its first Launch press, which adopts a kept check of its pool without asking or
spending. A background check never asks, and spends only to renew a list that passed a
check, within the approval as read again just before spending: any other charge ends it
with nothing spent, and for a list that never passed a check it only adopts, starting no
inventory, so a first check that spends is always the person's own press. It holds its
first write until nothing the person started is in flight. It never takes the verb or
the line beside a launch the list in use can serve, and a stop is said in Models only.
After any check stops, is cancelled or ends unspent, nothing starts on its own again
while the panel stays open until a check the person starts completes. An edit of the
rows cancels one that has not started writing; while it writes the model list the gate
holds edits as a step in progress. **ask first** in Setup withdraws the approval: a check
the person did not approve with a press then spends nothing more, asking instead (or, in
the background, ending unspent) if it is still listing models, and stopping if it is
measuring them; one already past measuring keeps what it paid for.

One gate decides every action: the launch, saving, checking models, approving a charge,
resuming with or without the profile, opening a running session, and every edit of the
team (including a recalled profile and a profile switch), the machine or the account
pool. Nothing starts while a step runs, and only Approve while a charge waits; edits
wait too, and a row still answers but refuses each choice with the gate's reason. A
chain asks the gate again before each later step (save, then launch once the save is
observed; review, then prepare, then open the terminal), so a team, machine, pool or
authority change mid-flight stops it with the reason. Save and launch refuse only a
lead no included account serves, as the session door does; fallbacks it would drop are
noted, never a refusal.

### Usage

The **usage** pane stands under routing, or alone as the **Usage** tab in a narrow
panel too short for routing under the generator. It lists providers in the panel's
family order (GPT, Claude, DeepSeek, then the rest) and, under each, its accounts by
email (else API key or identity). Each reported window of an account is one line: its
label (`5h`, `7d`), a twelve-block bar filled to the share used, the percentage, `↻` and
the time to its reset, and Code's word for it: `tight` from 80% used (or when the
provider warns), `maxed` when exhausted, `blocked` for a provider block, whose `↻` is the
time it lifts. Windows are never averaged across accounts or providers. Every reported
window is a row. A window with a tier meters a limit of its own beside the account's
shared windows, such as Anthropic's weekly limit for one model kind or a Codex named
limit, and its label names the tier (`7d fable`, `7d base-model-inference`) so it is
told apart from the shared `7d`. Only the shared windows judge the provider's pool: OMP
does not yet say whether a tiered limit stops every route of the account or only one
model's, so a used-up `fable` window makes Claude neither tight nor maxed. A prepaid
balance is shown in its own currency; an account with no windows says "no windows
reported"; a block on a scope no shown window meters is its own line ("<scope> requests
blocked ↻ Sat 16:55"). An account excluded from the pool, or whose credential is
disabled, is drawn in quieter colours. An account read from a stale source or longer ago
than the five-minute freshness window says its age ("12m old") and is never drawn as
current; a provider whose accounts are all history says it once. Where nothing can be
drawn the pane says "no account choices yet", "not read yet", "accounts unavailable" or
"no accounts". **Hide** in the head (`s`) removes the pane; **Show usage** in the
generator's head brings it back.

Its last line reads `next refresh 4:54` with a **Refresh now** button (`r`). Code reads
the usage again every five minutes, its freshness window: the host's feeds read again
on events while their channel is live, and provider readings change without one, so the
panel keeps its own cadence, by the same rules as its other reads on their own: a hidden
panel reads when it shows again, and a read that comes due in the middle of something
waits (the line says `refresh waits`). That cadence reads the usage, the sessions
already read and Code's Runs (which also read again on every Agent, Run or terminal
event), never the workspace profile or the machines, which keep the minute's
cadence above. Refresh now and `r` read everything at once and restart both countdowns.
The line says `refreshing…` and the bars drain and refill
while a read is out, for at least half a second so the refresh reads as one gesture;
under reduced motion nothing animates. The line reserves the width of its widest text,
so the button never moves.

### Accounts

The **Accounts** tab (`a`) replaces the stage with the usage grid again, each account
headed by a **switch**: "Include <who> in the workspace pool", a shared edit every
member's next launch draws on. A switch edits the saved choices through
`changeAccounts` at the observed revision, one edit at a time, never retried. A press
shows as made, and every switch stays locked, from the press until the saved choices
are read back at a newer revision, so a second press never carries a revision the first
has already moved past. A failed or refused edit is said in the readout and the switch
shows the saved state again. Same-email OAuth organizations are distinct switches.
Excluding an account is not disabling its native credential.

A switch that cannot act is never left looking open: it is `aria-disabled`, and a press
on it (like pointing at or focusing it) says why in the readout, in the model's words
where the model refuses ("Wait for the current step to finish", "Waiting for a current
read of the workspace profile"). It waits when no choices are set up yet, while a step
runs or a charge waits, when the workspace is read-only, while an edit is saving
("Saving the last change"), while the account list is historical ("The account list is
not current"), and for an account whose credential is disabled ("Credential disabled").
While a preset is active a switch says "Set by the <name> pool; choose the manual pool
under Manage accounts to edit", since hand edits belong to Manual. Opening the view puts
focus on its first switch that can move. `↑` `↓`,
`Home` and `End` move through the switches, `Space` or `↵` presses one, `m` opens
**Manage accounts**, `a` or Esc return to the generator.

**Manage accounts** (the button in the accounts head, or `m`) is the accounts'
management inside the same panel: the controls of the Code accounts panel, unchanged.
The pools live here: the active pool (Manual or a saved preset), creating, editing and
deleting presets with a local draft ("Save as preset…", "Edit pool"), and inclusion as a
checkbox per account, the same `changeAccounts` edit. It also signs in through OMP's
handoff and clears blocks or disables credentials behind a confirmation, and is
read-only while a step runs or a charge waits. **Back to accounts** (Esc) returns to
the accounts and `a` to the generator; the management stays mounted once opened, so an
unsaved preset draft survives a look back at the accounts.

### Sessions

The **Sessions** tab (`e`) replaces the stage with two groups, each said only where it
differs from the generator. What a row verb came to is said beside the view's name, on
one line that ends in an ellipsis, so it never moves a row. A refused verb says only its
reason, since the press named the row. Cut, the line is a Tab stop: focused, tapped or
pointed, it lays its whole words over the rows below without moving them, and `Esc` puts
them away.

**Sessions.** Rows are grouped under their machine, whose head names it once with its
read. Running sessions (terminals that carry an OMP session reference on their own
machine) offer **open**; while the terminal inventory is unread or failed, running is
"unknown", never none. Saved sessions appear only after an explicit read of each
permitted online machine (**Read <machine>**; a read machine says when it was read and
offers **read again**, failed reads offer **read again**, offline machines are named
once); Refresh now and the usage line's cadence read every machine already read again. Saved sessions take one row per
folder and machine: the folder first, then its newest session's title, when, and where
it stands among the folder's sessions ("newest of 6", "2nd of 6"), then the verbs. The
folder's other sessions are in that title's drum: `↑`/`↓` turn to a newer or older one,
`Home`/`End` go to the ends, `↵`/`Space` open the list below it, `Esc` closes it. A
saved session offers **resume** (as saved) and **with current profile** (resume with
the saved workspace profile); below 480 px a row takes two lines, folder and title,
then when and the verbs. The group's note says "profile not recorded" because no
session records the profile it ran with. Every row verb asks the one gate for its own
session before it is pressed and again between its steps. A refused verb stays
focusable and gives its reason, including that a saved session on another machine waits
until that machine is chosen beside the launch ("choose it on the line to resume
here"), since resuming runs on the launch's machine, and that a read-only workspace
allows open only.

**Runs.** An agent launch's Run heads its machine's group, one line per Run: an
activity mark and word (`working`, `blocked`, `done`, `idle`; `starting` before the
harness's first report; `detached` once it settled, by expiry, revocation or
cancellation, while its own terminal still runs, listed with the open Runs;
`completed`, `failed`, `cancelled`, `expired` or `revoked` once settled), its
title from the machine's saved read (else "new session"), its folder, its live
`model:thinking` in the provider's hue and one verb. **open** goes to its terminal;
**cancel** finishes a Run whose terminal never opened (it never stops a running TUI);
**resume** resumes a settled Run's saved session through OMP's Agent-free resume, as
the saved rows do, without a new Run or dials. An open Run also shows its **model** and
**thinking** dials, its **lease** as 24 blocks (one per renewal Manifold allows) with
"renews in 18m", "renewal due · expires 14:40", "expires 14:40" once no renewal is left,
or "detached since 12:50", and one said line of fixed height. A dial press is one
`atyrode.omp.controlRun` on the main agent: the word asked for waits paler with a
hollow dot ("sent · terra until it answers"), then the session's answer shows ("running
now", or "running now · thinking xhigh" when the model clamped it or the level before was
unknown). A model the session
does not serve is struck ("not served here · terra stays"); no answer within 20 s says
so and offers **send again**; a caller the door refuses reads "its launcher's or
sponsor's alone". A press while a change waits is said as next ("high · next · once terra
answers") and sent once the answer lands, the latest such press replacing an earlier one;
a Run whose dials lock meanwhile drops it. A starting or detached Run's dials are shown
off and send nothing. `←` `→` rest on a word
half a second before sending it, and any press in that half second sends only itself; `↵` and
`Space` send at once, `↑` `↓` go to the next dial of any Run. Pointed, a dial word says
what choosing it sends, the lease its next renewal and the activity what it means, all on
the said line, so nothing moves; the word just pressed keeps saying what its press came
to. The model shown is the Run's own `Run.model` as `listRunsV2` reads it. OMP's harness
reports the model its session serves as soon as its TUI is up and again whatever switched
it (a dial, the operator in the TUI, another tab), and Manifold records it once the Run's
harness confirms its launch serves it. `Run.model` carries no thinking once the harness
reports, so a Run this browser has not turned reads `?` from its TUI's first report, seconds
after it opens, and the launch's level only before; a level changed in the TUI alone is not
seen. The last answer this browser received, kept per workspace in local storage, is the
one word on the thinking. It bridges a confirmed dial until a read shows its model, since
a read served before the session reported the change can land after the answer: a read
still naming the model the Run had when the answer landed, or one an earlier answer was
still bridging, contradicts nothing, and neither does one naming the model of a change in
flight. A read naming any other model was switched elsewhere: it drops the answer, here
and from storage, and shows the answer another tab kept for that model, if any. A read
naming the model of a change left unanswered settles it. A model the Run's harness cannot
confirm, such as an OpenRouter one, leaves `Run.model` on its last confirmed value, so its
dial's answer stays bridged; the one switch this misses is one in the TUI back to that
value before any read shows another. The Sessions tab carries one square for the open
Runs, never a count: blocked, then working, then starting, else quiet.

**Recent profiles.** Each successful launch records its team in this browser's local
storage per principal and workspace (newest first, one entry per team, nine at most).
The list is device-local, never shared, and grants nothing; it does not record the
machine. A profile keeps its digit for the panel's life: relaunching it keeps the
digit, a new one takes the next free one. A row says only the settings that differ from
the generator, extras as changes ("no fallbacks"), or "this profile", and what recalling it
would strand on today's pools ("12 no route until 16:55", each group with its own
time). A profile today's catalog cannot form is refused, its word dimmed with the
reason in its title. Pressing a row, or its digit `1`–`9`, recalls the profile through
the edit gate and announces what it strands; it launches nothing, and recalling the
saved workspace profile is a discard, not a local edit that happens to match. When the
generator holds the saved workspace profile and no recent profile says it already, the
group says "Workspace profile · last change to the workspace <time> by <name>": every
write to the workspace record stamps that time and name.

### Keys, focus and layout

Keys are panel-local: the listener sits on the panel root, so a key pressed in another
plugin never reaches Code and a key Code consumes does not reach workspace-wide
bindings. None act behind a sheet, in a dialog (Shortcuts included) or an open popover
(More, the machine list, a session drum), in a text field, or once a nearer control handled
the key. The panel takes focus when it opens; from there an arrow moves focus to the
generator's rows. Each of these has a control; none is the only way to anything.

- **Main view.** `↑` `↓` move between rows. On a row, `←` `→` step to the nearest word
  that can be chosen, `Home` and `End` jump to the ends, and `Space` flips fallbacks;
  focus stays on the row's chosen word as the value moves. The wheel steps a row only
  while the row has focus or the pointer has rested on it for 450 ms, so a page scroll
  passing over never turns it. `↵` takes the launch's step unless a button has focus,
  which answers it itself; `Mod+↵` takes it from anywhere in the main view, typing
  included. Neither acts on key repeat. `d` Defaults, `z` Revert, `f` fallback chains,
  `w` the machine list, `p` and `s` hide or show routing and usage, `a` the accounts,
  `e` the sessions, `m` Models, `u` Setup, `o` Options.
- **Accounts.** `↑` `↓`, `Home`, `End`, `Space`, `↵`, `m` and `a` as above.
- **Manage.** Esc returns to the accounts, `a` to the generator.
- **Sessions.** `↑` `↓` move, `1`–`9` recall a recent profile, `e` or Esc go back.
- **Routing and usage tabs.** Where they are tabs of their own, `p` and `s` open routing
  and usage rather than hide them, and return to the main view from their own; there Esc
  goes back, `a` opens the accounts and `f` shows the chains in routing.
- **Anywhere in the panel.** `r` is Refresh now: everything read again at once. `?`
  opens Shortcuts.

`Esc` goes back: from the management to the accounts, from any other view to the
generator; at rest in the main view it is left alone. The **key line** at the foot is
short and names only the keys of the view shown, then `? shortcuts`: in the generator
`↑↓ move · ←→ change · ↵ <step> · a accounts · e sessions`, in the accounts `↑↓ move ·
space include · m manage · esc generator`, in the management `esc accounts`, in the
sessions `esc generator`, preceded by `↑↓ move · 1–N recall` when recent profiles exist.
Words are not buttons, since every action is a control elsewhere. For a coarse pointer,
which has no keys, the key line is hidden, and every button, tab and radio is at least
44 px. One polite live region announces outcomes, failures, recalls, commits and the
reason a pressed control gave, whatever the notice stack also shows, since a notice row
that arrives with its words is not reliably read out; a question announces itself as a
dialog.

The layout answers the panel's own measured size, never the window's, since Code
shares the window with its canvas. From 760 px the generator and routing stand side by
side with usage under both. The generator is as wide as its rows need, never under 42%
of the panel, and routing takes what that leaves, never under 36%, so the room the rows
do not need goes to routing's fallback chains. What the readout and the launch line say
never moves that divide. The generator and routing are as tall as the taller of them, and
usage follows them, so the room a tall panel has left lies below everything rather than
inside the generator.
Below 760 px routing stands under the generator and usage under routing when the panel is
tall enough for the generator, without its grouped profile, and the whole routing, without
its fallback chains, at once; otherwise the generator stands alone with the grouped profile
under its rows, and routing and usage are tabs of their own. The fit is judged from what is
rendered, once a resize has settled and when the stage's structure changes (the routes or
the generator's rows, routing hidden or shown, a return to the generator), never when the
readout, the launch line or the fallback chains change: what then runs past the panel
scrolls, so the launch never moves under the pointer and the chains never send routing
back to a tab. Widening the panel closes a routing or usage view. Below 430 px the lead's
words drop under its label so the leads and the only box keep one line, and below 380 px
usage windows use thinner blocks and drop the word "used". Nothing scrolls sideways at any
width. Hiding routing or usage is local to the open panel and not kept. The first layout,
every resize and every change between the two narrow arrangements place things without
motion; a pane that comes into view slides in, and under reduced motion nothing moves.

### Drafts and what persists

An unsaved team survives a reload in the tab's session storage and returns only onto
the catalog or model list it was made on (see the verification section above). So does
the machine chosen beside the launch, per principal and workspace, subject to the
default rules above. Recent profiles persist in the browser's local storage, as
described under the sessions. Session options live only in the open panel and clear
after a successful launch or resume. A preset draft, a catalog draft and the visited
sheets stay as long as the panel is open.

### Session options, Models and Setup

**Options** (`o`) opens a sheet in two parts. **Profile switches** (priority, prewalk
and auto plans) are saved with the workspace profile through the edit gate, and refuse
with its reason or with the domain's ("Priority needs a GPT lane"). Below them,
Automation and Optional skills apply to the next launch or resume only: the workspace
profile stays as it is, the restrictions are not an OS or network sandbox, and a
successful launch or resume clears them. The summary on More and its Options item
retains restricted tool counts, skill selections or explicit disable-all.

**Models** (`m`) shows the list as the generator uses it: one ladder per provider (fast,
normal, smart, elite), as a matrix with tiers down and providers across from 760 px of
sheet width and as one ladder under another below it. Each rung is its model's alias in
the provider's hue with its measured speed as five blocks (under 30 tok/s one, then 45,
60 and 90; none measured is a hairline track); an empty rung is a dash, and pointing at
one the family offers names the rung the model row lands on instead, while one above the
family's top (an elite it lacks) says only that it has no model, as the model row refuses
it. A family Code requires that lacks a rung of its own at fast, normal or smart reads
**· short** beside its name. The head says
how many models are in use and when they were checked, with **OMP updated since** when
OMP's runtime or catalog moved after that, or that accounts changed or OMP dropped a routed
model since they were checked, that a staged list waits beside them, that they are being
checked, or that they are not checked or the bundled starter, with **import**
(`i`) and **export** (`x`) as two quiet words. Beside the list
is what the step is about: the charge per provider and the models not probed while
checking, a staged list's changes (field by field, a model added or dropped, the old
value struck), or, after a check measured in this panel, the models it left out, each
with its reason in a word: a model the accounts' plan, their settings or this client
excludes (`client_blocked`) reads **not served**, one no account finds (`not_found`) **not
reachable**, one whose check got no clear answer (`inconclusive`) **no answer**, a model in
OMP's `spark` quota class **retired** and any other class of its own **own quota**. Ids,
prices, speeds, thinking ranges and reasons
appear only in the readout line while a cell, a provider or a left-out model is pointed
or focused.
One next action sits where the launch sits and follows the step: **check models**,
**checking models…** (drawn with the checking hold the charge keeps; while the charge's
question is open over the sheet it reads "waiting for your approval" beside it),
**checking…** with the requests measured, then **back to code**
with **check again** beside it, the same check a list that holds can always renew, which
spends without asking within the standing approval; a check again that stopped, one the
panel ran on its own included, reads **check stopped** beside it, with its
reason in the readout, since what it would have changed (the list, or for a stop while
saving the profile, the team) stays as it was. An adopted check measured nothing here,
so nothing reads as left out after it.
A staged list offers **use staged list**, which reviews the staged list at its revision
and promotes exactly that review with the list's own default team, and **discard**. An
unsaved edit made on the list a write would replace holds it, saying what the write does
to that list (putting a staged list in use resets the profile to the staged list's default), with **save**
(an edit of the team in use, kept on the list in use) and **discard edit** beside it.
Checking refused for want of
discovery offers **enable in setup**; another refusal names itself with its fix (show
accounts, retry, open Setup, use theirs). Esc cancels a run that can still be stopped,
and otherwise returns to Code. Import takes a pasted or dropped Code model list, checks
that it compiles, and stages it beside the list in use, initializing an absent workspace
first; nothing is checked or put in use until **use staged list**, and a list put in
use that way is not checked. An import over a staged list replaces it, a checked one
included, and says so in its dialog and in the readout once staged. Export copies the
list in use. The per-field editor, the
separate discovery and benchmark controls and job recovery are gone: a check runs
discovery and benchmark as one step, and OMP's own history keeps every job.

**Setup** (`u`) is one checklist for the chosen machine: machine, OMP, connection,
discovery, sessions and folders, each a square mark, a label and its value. A row that
depends on something missing says so ("needs omp", "unreachable") rather than claiming
a state. The first row with a fix due is pointed (▸) and its fix is the one next action:
**use** another machine where OMP answers, **check again**, **review connection**,
**enable discovery**, **enable sessions**, **check folders** or **create folders** (the
folders row's **existing** and **new** route), each review opening the native permission
review of what it allows; once every row is ready, **back to code**. Folders count as
prepared only by an OMP job matching the machine's current operation, installation,
artifact and bindings. Beside the checklist are the profile's facts (revision, the
models in use and when checked, what the last check left out, the source, the standing
approval of checks with **ask first** to withdraw it, and the workspace) and the optional
classifier: **suggestions** off or ollama, with an
origin and a model, reviewed then applied through `reviewServices` and
`configureServices` as the next action; only the instance owner configures it.
Destination changes still invalidate native reviews and clear destination-specific
session choices.

## Ordinary Code/OMP workflow

`createCodeWorkflowClient(dispatch)` is React-free and uses the same ordinary
Manifold action transport as the web. It composes `createCodeClient` with
`createOmpClient`; no Code server proxies an OMP action. A door that validates an
Agent's profile (`core.access.registerAgentV2`, `updateAgentV2` and `launchRun`) and is
refused with `exclusive request requires a drained guest` or `profile validation requires
exclusive guest access` is asked again after 150, 300, 600 and 1200 ms, then the refusal
stands ("OMP was busy for a moment. Try again."): Manifold validates the profile in OMP's
isolate only while that isolate serves nothing else, and refuses rather than waits,
before the door does anything. No other door is retried. Important flows are:

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
  pool and read the caller's own checks; a newer kept check of that pool and budget is
  adopted instead, with no job. Otherwise start OMP's job, then read OMP's typed
  retained receipt. Benchmark binds the inventory job; derived catalog data is staged
  only through a later explicit Code CAS, which keeps it as the caller's check.
- **Session:** compose Code policy and read OMP defaults, request OMP's native
  review, then re-compose/re-read before prepare. Changed Code digest or defaults
  revision refuses. Only OMP's returned destination, review digest and
  `TerminalRuntimeSchema` reach `host.authoring.createTerminal`.
- **Sign-in and usage:** OMP accounts owns setup, terminal placement and current
  observations. Code projects usage through shared account choices. The web
  polls on the live owner event channel, retains the last permitted reading
  while a refresh is pending or refused and labels source age separately from a
  quota reset. The main view also reads usage again every five minutes, Code's
  freshness window, and on `r`; a reading older than that is shown as history.
- **Agent launch:** `launchAgent(review)` re-composes the reviewed session (same Code
  digest and OMP defaults revision), then makes Code's Agent carry it: one Agent per
  sponsor and workspace, named `Code <first 16 hex of SHA-256(containerId)>` (a
  retired one passes the name to `… 2` and on), registered through
  `core.access.registerAgentV2` with harness `atyrode.omp`, profile
  `{ accountPool, overlay, planYolo: false, tui: true }` and a grant of one scope
  rectangle (the container, `subtree`, `containers:read`), a 1 h lease, delegation 0/0
  and an expiry of 14 h. Registration is idempotent per sponsor and name;
  `updateAgentV2` follows only a changed profile or a grant that no longer covers a
  full Run window (13 h). The one-time runner credential is never kept. It then calls
  `createRunV2` with `{ agentId, target: { machineId, containerId }, reach: "subtree",
  lifetimeMs, scope, model }`, where `model` records the launch's main-agent selector
  as `provider` and `id:thinking`, and `launchRun`. It accepts only OMP's
  `atyrode.omp.harness` runtime with `tui: true` for that machine and session; the web
  opens it with `host.authoring.createTerminal` within the minute Manifold binds it
  for. Any refusal or mismatch once the Run exists, a refused placement included,
  cancels the Run (`finishAgentRunV2`, `cancelled`), and a failed cancellation is
  named. `agentLaunchBlocker` keeps the launch the reviewed session for automatic
  plans (`omp_tui_plan_unsupported`), skills or restricted automation (`launchRun`
  hands the harness only its destination), a destination without the harness
  operation, a caller without `canRegister`, or unread Agents. A sponsorship refusal
  at registration or Run creation, before any Run exists, does the same for the
  panel's life; so does a machine whose `launchRun` refuses agent runs
  (`run_launch_protocol_unsupported`, `omp_harness_runtime_unsupported`), for that
  machine ("no live dials: <machine> cannot launch agent runs"). In either case the
  same press, once the Run is cancelled, launches the reviewed session while the press
  still stands. `readRuns(containerId)` lists the visible Code Agents named for the
  workspace, their Runs, each listed Run's inspection (renewals, settlement, exit code)
  and the terminal inventory. An open or expired Run's TUI is a running terminal of its
  session opened while the Run stood, so a later Run-less resume of that session is an
  ordinary running row; a Run settled otherwise keeps a future expiry, so its TUI is only
  a terminal its inspection names. Every Run whose session still runs a terminal is
  inspected, whatever its age. `controlRun(runId, { model?, thinking? })` is OMP's door.
  A Run whose lease ends, after a missed renewal or the 24th, settles `expired`, but
  its terminal job runs under the opener's credential and goes on, so Code shows it
  as detached while that terminal runs; Run input, and therefore its dials, then
  refuses.

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

The session options sheet presents available and selected metadata, deliberate sets and
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
The sessions view requests each permitted online machine explicitly (a **Read**
control per machine) and distinguishes pending,
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

The sessions view offers separate **resume** (saved state) and **with current profile**
(the saved workspace profile) actions on a listed saved session, and **open** on
a running one. Session options chosen in their sheet apply to the resume. Resuming with
the current profile needs the
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

The accounts view's switches include or exclude exact full identities or API-key
slots in the active pool through one guarded `changeAccounts` edit; the manage view,
which is the Code accounts panel's own, chooses the pool (Manual or a saved preset),
edits presets, and offers the same inclusion as a checkbox per account. Same-email
OAuth organizations are distinct choices. Manual
changes save immediately; while a preset is active, accounts change only by choosing
another pool, because hand edits belong to Manual. Edit pool creates a local preset
draft, and creating a preset does not activate it. A preset named “Manual” is still a
saved preset. A switch is locked for every account while the account list is historical,
and for an account whose credential is disabled. Excluding an account is not disabling
its native credential; credential actions and sign-in remain explicit OMP handoffs.

Usage lists reported windows per account, never an average across incompatible
windows or providers. Missing capacity has no fabricated meter. Failed reads keep
the last permitted facts visibly historical, with their age, including blocks, reset
deadlines and balance; none proves current availability. The main view's usage pane
and accounts view draw the same grid of windows; reset credits and the per-account
detail are in the manage view's readings. Exact selections omit providers
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

OMP derives the service scope from custody of the broker's credential store: the
broker service, its owner machine and a custody id kept inside the store, never
the broker's configuration revision. Restarts, disable and enable, and broker
promotion (including the one each OMP accounts upgrade needs) keep saved choices
resolving. A new, purged or replaced store, or another owner machine, changes the
scope as a cutover does. Adopting the OMP release that introduces this changes
every scope once, at the promotion that first stamps the store; take the
`previous` observation for `rebind-scope` before that OMP version is admitted,
because reads refuse `omp_account_runtime_outdated` from admission until the
promotion.

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
