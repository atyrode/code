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
performance, context, thinking levels and image support. Capabilities are 1–4. Tier 0
was Spark's off-ladder rung and is retired: a stored catalog that still lists a tier-0
model keeps parsing, and the model is never placed or routed. `SelectionSchema` records
lane, capability, thinking, advisor, priority, prewalk, plan-yolo, fallback and budget
(always the domain's default, `any`, in the panel), and still parses a `spark` flag,
which is read as off. Code never recovers these semantics from terminal output.

Known providers may add named families, quota metadata, priority
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
context, image support and thinking levels; any quota class other than chat (Spark's,
for one) is excluded, since Code spends no quota of its own. Unmeasured performance stays null. Derivation admits at
most 256 budget-eligible candidates before constructing ladders; it never truncates.

Only a successful canonical configuration read establishes an absent revision 0
or an initialized-empty positive revision. Loading and failure are not absence.
The local starter freezes the full metadata snapshot, catalog, selection, base
revision and account-independent configuration digests. Existing active policy
wins, including historical catalogs without recorded registry provenance. A saved
staged catalog is an explicit preview, not an active profile or a bundled fallback.
An unresolved catalog keeps Models repair reachable; the main view then says the
model list is unavailable, with Retry and Models, whatever else the launch line says.

The starter is render-only. Nothing writes it as the workspace's catalog except a
model verification, `workflow.verifyModels(target, { expectedRevision, budget })`:
the one way a Code catalog comes to name models, because only a probe shows which
this operator can call. Preparing reads the workspace at `expectedRevision`
(initializing an absent one), runs OMP's inventory with the pool Code composes from
the saved account choices, and returns the charge, the number of tiny benchmark
requests per provider, having probed and spent nothing. A catalog routes only its
rungs, so the charge probes every eligible model of a family Code requires (OpenAI,
Anthropic), whose ladder must survive a model that does not answer, and only the
rungs any other family's listing ladders (DeepSeek, OpenRouter, any other provider);
such a rung that does not answer leaves that family shorter. Only the returned `confirm`
spends: one benchmark job per provider, then derive, stage, review, promote and save
the selection narrowed to what the verified catalog hosts. Every step re-observes the
revision, the exact account pool and OMP defaults, and stops, naming itself, when one
moved, on a refusal or on cancellation. A stop never undoes: probe jobs stay in OMP's
history and a staged catalog stays staged. A confirmation is used once, and a failed
or uncertain one is never replayed. The promoted catalog records its verification
provenance (OMP version, inventory and benchmark times, the account providers and a
digest of the exact account pool). A catalog stops being verified when OMP serves
another model list or the saved choices select another pool. A model that draws a quota
of its own (any OMP class but chat, Spark's for one) is left off the derived ladder and
listed among the last verification's excluded models, since Code spends no such quota.

A stale or failed save is never retried or rebased. The local draft remains
exportable until explicitly discarded. It also survives a reload: the main view keeps
an unsaved team in the tab's session storage per principal and workspace, with what
it was made from (base revision and team, the catalog digests, whether choices
existed, and for a first-use draft the bundled model list), never the catalog itself.
After a reload the draft returns only onto that same catalog or list; otherwise it is
dropped without a word. A returned draft is judged like any other: a write that left
its team and catalogs alone moves its base forward, and a foreign team or catalog
write is a conflict. A draft that only repeats the team the view shows without it is
not kept. Skills and automation (the session options) are independent ephemeral
launch choices, never part of the saved profile. The main view has no task: it opens
an interactive session and the task is typed there, so its launch review carries an
empty prompt. Headless callers still pass a prompt.

## Workbench presentation

The main view is one panel. A **top bar** carries the views as tabs (Generator,
Accounts, Sessions) and one **More** menu (Models, Setup, Options, Shortcuts). The
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
states stay visible in the launch line, with full error detail reachable deliberately
in Setup's connection details.

Every action is a visible control; keys are accelerators for them, listed in the
**Shortcuts** dialog by the view they act in. A control names its key in its tooltip and
`aria-keyshortcuts` only where that key does what the control does in the view shown:
the Generator tab names Esc or `a` only from the views where they go back to it, and
Models names `m` only in the generator, where `m` opens Models rather than Manage accounts.

### The top bar

The tabs are a tab list: `←` `→` move among them and `↵` or `Space` opens one. Below
760 px of panel width **Routing** and **Usage** join them, since those panes are views
of their own there. **More** keeps to the bar's end and is a standard menu button: a
press, `↓`, `↵` or `Space` opens its menu on the first item and `↑` on the last; `↑` `↓`,
`Home` and `End` move, `↵` or `Space` chooses, and an item's own key (`m`, `u`, `o`, `?`)
chooses it too. `Esc` closes the menu and returns focus to More; `Tab`, a press outside
or focus leaving closes it. Choosing returns focus to More, where a sheet or dialog
gives it back. **Models**, **Setup** and **Options** open their sheets (`m`, `u`, `o`
from the main view, where the menu shows each key beside its item). While a staged model
list waits beside the active one, More reads **More · staged** and its item **Models ·
staged**, since nothing changes until it is reviewed there. When session options are
set, More and its **Options** item carry their summary ("· restricted", "· skills off",
"· 2 skills"). **Shortcuts** opens a native modal dialog that lists every key under the
view it acts in (Generator, Views, Accounts, Sessions, Anywhere), with `m`, `u` and `o`
under Generator, where they act; `Esc` or its Close button closes it and it owns its
keys while open.

The workbench reads its inputs again on its own: the workspace profile, OMP's setup,
defaults, bundled model list, skills and accounts, and the machine list, once a minute
while the panel shows and once when it shows again (its page returns or the panel comes
back on screen) unless it read in the last 15 seconds. A minute keeps a panel left open
current within a glance's patience for a handful of small reads, and a hidden panel
reads nothing. Such a read never lands in the middle of something: while a step runs or
a charge waits, a sheet, Shortcuts, More or the machine list is open, a row is being
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

### The generator

Rows run top to bottom: **lane**, **model**, **thinking**, **advisor** and
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

- **Lane** is a spectrum: each provider's lanes, **Mixed** between GPT and Claude, then
  every other provider's lanes as a group of its own. A lane is hidden only while its
  family has no signed-in account at all, unless it is the lane in use; with no account
  signed in anywhere every lane shows. A lane whose accounts are all excluded stays,
  refused with the domain's reason. A family someone has signed in for but the model
  list has no model of keeps its lanes, struck, with "No <family> models in your model
  list"; pressing one starts **Verify models** (through its own gate, spending nothing
  before Confirm charge) and the readout says it finds the models the accounts reach.
- **Model** is the capability tier (fast, normal, smart, elite), each tier read as the
  model alias its `default` role would lead on in the profile that choosing it forms,
  with the tier's word under the alias. A tier no model fills reads as its word alone,
  refused. A curated catalog's own keys (`sol`, `opus`) are its aliases. A derived key
  (`provider.id`) is named by the last id segment that is not a version or qualifier
  (`gpt-5.6-sol` is `sol`, `claude-haiku-4-5` is `haiku`); models whose aliases collide
  keep their full ids, since two models wearing one name would misreport the route.
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
come from the review on display: the reviewed composition while it is current, else
the local review.

The **fallback chains** checkbox in routing's head (`f`) shows the chains behind each
lead (`lead → fallback → fallback`) while the profile's fallbacks are on. With fallbacks
off the checkbox is refused, and a press (or `f` in the main view) takes focus to the
fallbacks row and says there are no chains to show. Its state is local to the open
panel. **Hide** in routing's head (`p`) removes the pane; **Show routing** in the
generator's head brings it back.

Whenever routing is not beside the rows (a narrow panel, or hidden) the team shows
under the rows grouped by what it runs: each group's `model:thinking`, then its roles
with `●` on agent-backed ones. A change that moves a role between groups glides it
there.

The **cost** and **speed** meters sit above the launch: five glyphs each (`$` and `»`),
lit to the level in the lane's accent, and the level's word while pointed. Cost is a
role-weighted relative list-price index, lowest to highest, not billing; subscriptions
spend quota windows, which usage shows. Speed comes from measured throughput and
first-token time, and only when every lead model has them: otherwise its glyphs stay
unlit and the readout says "unmeasured · verifying models measures it", rather than
showing the index's middle level.

### The launch

The launch row reads `↵ <step> on <machine ▾>`: the **launch** button, the machine
dropdown, and the **launch line** (below) beside them. The launch row is anchored to
the bottom of the generator and the launch line grows upward, or sits above the launch
when it has no room beside it, so the launch never moves under the pointer while its
line changes. The step is the label of the next step in lower case: **verify models**,
**review**, **save**, **save & review**, **save & launch**, **launch**, **launch
anyway** or **review in Models**, and **checking…**, **verifying…**, **saving…**,
**reviewing…**, **launching…**, **resuming…** or **working…** while one runs.

**The machine.** The dropdown shows the machine's name, a neutral dot that shows
whether it is online and a chevron. It opens a list of the machine roster above the
launch row; click, or `w`, opens it with focus in the list. `↑` `↓`, `Home`, `End` and
`↵` or `Space` choose; `Esc`, `Tab` or a press outside closes it and returns focus to
the dropdown. While open the list owns its keys, so the panel's keys do nothing.
Choosing goes through the edit-machine gate: while a step runs or a charge waits the
dropdown refuses with the gate's reason and leaves the Tab order, so Confirm charge is
the next Tab stop after the launch. An offline or access-revoked machine is struck and
refuses with its reason, and so is a machine OMP is not installed on ("no OMP here"),
which can run nothing. Code checks every online machine for OMP, and a browser starts
on the destination it saved in the tab if OMP answers there, else on the first online
machine where it does; with none, the saved one or the first online machine stays
chosen so the launch line can say why nothing runs there, and nothing is chosen before
every online machine has answered. The readout says what the pointed machine is
("online", or why it cannot be chosen). The machine is the destination, not part of
the team, and is not recorded in recent profiles.

**The verb.** The launch is one control whose `data-state` is `ready`, `busy`,
`waiting` (a charge waits on its own Confirm) or `refused`. It is `aria-disabled`
rather than disabled and stays focusable, so a step changing its state never drops
focus, and a launch-line control that leaves once pressed hands focus to the launch;
pressing a refused one shakes it, says the reason in the readout and announces it. A
read-only workspace (no `containers:write`) is stated in neutral grey, "Read-only
workspace" (its readout adds "changes stay a local preview"). Write access is the caps
alone: without a canvas beside the panel, verifying, saving and account edits still
work, and only launch and resume refuse, in neutral grey, "Open Code beside the
workspace canvas to launch". **Launch anyway** is offered when a role's pools are out,
never for a lead no included account serves, which save, review and launch all refuse.
**Review in Models** opens Models for a staged-only workspace. Verify is refused up
front when the account observation cannot be read or includes no account. An edited
team saves first; while the launch is pointed or pressed the readout says what the save
changes ("2 changes to the profile: thinking high → max, advisor glance → off"), and
**Revert** discards the edit. **Save & launch** is offered when the projection rests
on present readings (every lead's pool judged fresh and the served providers known),
and the press then continues from the review to the launch only if the review shows the
projected leads and the same providers in the account pool; otherwise it stops and says
what differs (roles' leads, providers that joined or left the pool) as a choice: launch
with the reviewed pool or change a setting first. **Save & review** stops at the
review so the pool is seen first. Outcome and refusal lines clear whenever the team,
machine or account pool changes.

**The launch line** sits beside the launch and keeps to facts and one-press fixes, each
a button; its asides ("changes stay a local preview", "nothing is spent until you
confirm", and, while a staged model list waits beside the active one, "a staged model
list waits in Models") are said in the readout while the launch is pointed or pressed. It is written in this
precedence: a verification running or its charge, a step in flight, the verb's refusal
with its fix, a staged model list the verb opens, a review that differs from what was
projected, a failure, the last outcome, and roles with no route with the one change
that routes them (said once verifying is no longer the next step). A model list that
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
  with **Use <machine>** for another online machine where OMP answers. "Verification
  readiness unknown on <machine>" is kept for a read that really failed.
- **Machine.** "<machine> is offline", "access revoked", "is unavailable", "The chosen
  machine is not in your machine list" or "Machine list unreadable", each with **Use
  <machine>** or **Retry** where one applies.
- **Models and setup.** "A staged model list waits in Models" (**Review in Models**),
  "No model list in use" and "These choices need a model review" (**Open Models**),
  "Discovery is not enabled", "Sessions not enabled on <machine>" and "Sessions
  unavailable on <machine>" (**Enable in Setup** or **Open Setup**), and "Skill choices
  need attention" (**Open options**).

A fix that opens a place answers to that place's key too.

**Verification and its charge.** **Verify models** runs OMP's inventory ("Checking
which models your accounts can reach"), then states the charge: "Verifying spends N tiny
requests", per provider, with **Confirm charge** and cancel. A charge of nothing says
"Nothing to verify through these accounts" and cannot be confirmed. Confirm is a Tab
stop after the launch, is never focused for the person, and spends only the very charge
it showed: never one of zero requests, never before the Verify press has stayed in its
checking state for 700 ms, and only on a deliberate single press, never the second
click of a double-click or a held key. Progress reads "N of M requests". A verification
that stopped or was cancelled says so until the next one starts; Verify models again is
its retry.

Once the saved, verified team meets every launch precondition and its review inputs
(options, accounts, revisions, destination) have held still briefly, the workbench
requests the launch review itself, so Launch is one press. It never does so for an
unsaved edit, a starter or a staged catalog, and at most once per review scope: a
refused review or launch waits for an explicit Review or a changed input.

One gate decides every action: the launch, saving, verifying, confirming the charge,
resuming with or without the profile, opening a running session, and every edit of the
team (including a recalled profile and a profile switch), the machine or the account
pool. Nothing starts while a step runs, and only Confirm while a charge waits; edits
wait too, and a row still answers but refuses each choice with the gate's reason. A
chain asks the gate again before each later step (save, then review once the save is
observed; prepare, then open the terminal), so a team, machine, pool or authority
change mid-flight stops it with the reason. Review and launch refuse only a lead no
included account serves, as the session door does; fallbacks it would drop are noted,
never a refusal.

### Usage

The **usage** pane stands under routing, or alone as the **Usage** tab in a narrow
panel. It lists providers in the panel's family order (GPT, Claude, DeepSeek, then the
rest) and, under each, its accounts by email (else API key or identity). Each reported
window of an account is one line: its label (`5h`, `7d`), a twelve-block bar filled to
the share used, the percentage, `↻` and the time to its reset, and Code's word for it:
`tight` from 80% used (or when the provider warns), `maxed` when exhausted, `blocked`
for a provider block, whose `↻` is the time it lifts. Windows are never averaged across
accounts or providers. Every reported window is a row. A window with a tier meters a
limit of its own beside the account's shared windows, such as Anthropic's weekly limit
for one model kind or a Codex named limit, and its label names the tier (`7d fable`,
`7d base-model-inference`) so it is told apart from the shared `7d`. Only the shared
windows judge the provider's pool: OMP does not yet say whether a tiered limit stops
every route of the account or only one model's, so a used-up `fable` window makes
Claude neither tight nor maxed. A prepaid balance is shown in its own currency; an account
with no windows says "no windows reported"; a block on a scope no shown window meters
is its own line ("<scope> requests blocked ↻ Sat 16:55"). An account excluded from the
pool, or whose credential is disabled, is drawn in quieter colours. An account read
from a stale source or longer ago than the five-minute freshness window says its age
("12m old") and is never drawn as current; a provider whose accounts are all history
says it once. Where nothing can be drawn the pane says "no account choices yet", "not
read yet", "accounts unavailable" or "no accounts". **Hide** in the head (`s`) removes
the pane; **Show usage** in the generator's head brings it back.

Its last line reads `next refresh 4:54` with a **Refresh now** button (`r`). Code reads
the usage again every five minutes, its freshness window: the host's feeds read again
on events while their channel is live, and provider readings change without one, so the
panel keeps its own cadence, by the same rules as its other reads on their own: a hidden
panel reads when it shows again, and a read that comes due in the middle of something
waits (the line says `refresh waits`). That cadence reads the usage and the sessions
already read, never the workspace profile or the machines, which keep the minute's
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
differs from the generator.

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
- **Narrow routing and usage views.** Esc goes back and `a` opens the accounts; `p` and
  `s` open routing and usage, and return to the main view from their own; `f` shows the
  chains in routing.
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
44 px. One polite live region announces outcomes, failures, the charge, recalls and the
reason a pressed refused control gave.

The layout answers the panel's own measured width, never the window's, since Code
shares the window with its canvas. From 1180 px the generator and routing stand side by
side with usage under both; from 760 px the same in slightly different proportions.
Below 760 px the generator stands alone with the grouped team under its rows, and routing
and usage are tabs of their own; widening the panel closes such a view. Below 430 px the lane's words drop under its label so the
spectrum stays on one line, and below 380 px usage windows use thinner blocks and drop
the word "used". Nothing scrolls sideways at any width. Hiding routing or usage is
local to the open panel and not kept. The first layout and every resize place things
without motion; a pane that comes into view slides in, and under reduced motion nothing
moves.

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

Setup (`u`) is optional runtime management: connection status, independent machine
capabilities, folder preparation and the external suggestion classifier, and, under
Profile & source details, the displayed catalog's source, the destination and the
last verification's excluded models. Models (`m`) leads with authoring/discovery; the editor
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
  quota reset. The main view also reads usage again every five minutes, Code's
  freshness window, and on `r`; a reading older than that is shown as history.

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
