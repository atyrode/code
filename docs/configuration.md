# Configuration

## Headless commands

These commands use the same local catalog, launchers, account broker and state
as the TUI. They do not start a Code network daemon or grant a remote client
authority: whoever invokes them acts with this machine's permissions and
configured broker access. Broker reads may contact the configured broker;
`suggest` sends its prompt only to a loopback evaluator. This CLI surface is
not a claim of full Manifold web parity.

Plain `code` still opens the TUI. `code engine --configure` still requires the
operator's interactive confirmation to mint an immutable profile, including
any ceremony-only local model choice; none of these commands replaces it.
Existing `CODE_*` configuration remains in force, notably `CODE_GENERATED`,
`CODE_OMP`, `CODE_OMP_UNTRUSTED`, `CODE_RUNTIME_BROKER`, `CODE_AUTH_VAULTS`,
`CODE_AUTH_VAULTS_FILE`, `CODE_AUTH_ACCOUNT_STATE` and `CODE_USAGE_CACHE`, plus
the [state-root overrides](#state-on-disk).

### Launch without the dials

```bash
code launch
code launch --selection '{"model":"smart","fallback":"off"}' --prompt "fix the failing tests"
code launch --worktree --prompt "review this repository"
code launch -- --continue
code launch --kind managed --prompt "explain this repository"
code launch --kind untrusted --prompt "inspect this unfamiliar repository"
code launch --kind runtime --runtime TARGET --selection '{"thinking":"high"}'
```

`--selection` is exactly one JSON object with unique keys and string values.
Omitting it is equivalent to `{}`: start from catalog/capability-adjusted
defaults, **not** saved TUI dial positions. Unknown facets, duplicate keys,
non-string values, unavailable provider lanes and incompatible combinations
are refused; explicit choices are not silently rerouted to another provider
or tier. Use `code inspect` to discover this machine's supported facets, and
`code inspect --selection '{"model":"smart"}'` to preview a particular choice.
Headless selection does not read or overwrite `CODE_SELECTION_STATE`.

| `--kind` | behavior |
| --- | --- |
| `generated` (default) | requires a runnable catalog combination and an available provider lane; launches with an ephemeral routing overlay, without rewriting omp config |
| `managed` | trusted launcher without generated routing; no facets; honors the configured account selection |
| `untrusted` | invokes `CODE_OMP_UNTRUSTED` (otherwise `ompu`); no facets; choosing this launcher does not itself establish engine sandbox containment |
| `runtime` | requires `--runtime TARGET` naming an advertised runtime target; accepts only the `thinking` facet, and delegates to the configured runtime broker |

Replace `TARGET` with a name in `code inspect`'s `runtime_targets`.
`--runtime` is invalid for other kinds. `--worktree` requires a Git repository
and uses the normal session worktree lifecycle: pristine trees are retired on
exit, while changes or commits keep them for recovery. `--prompt TEXT` supplies
the first message. All omp arguments must follow an explicit `--`; positional
text before it is an error. Forwarded routing/profile flags receive the same
filtering as the TUI, and forwarded omp switches follow the dial-generated
ones. Launch attaches to the real session; it is not a JSON response.

Recovery remains `code ls`, `code session reap`, `code wt`,
`code wt resume <name|id>`, `code wt remove <name>` and `code wt prune`.
The existing dry-run/`--yes` and live/dirty-worktree protections still apply.

### Inspect and suggest

```bash
code inspect
code inspect --selection '{"model":"smart","fallback":"off"}'
code suggest --prompt "fix a typo in the help text"
code suggest --selection '{"model":"smart"}' "review the authentication boundary"
```

`inspect` returns one JSON object containing `catalog`, `selection`, `facets`,
`routing`, `estimates`, `providers`, `launch_modes`, `runtime_targets`,
`session_registry`, `sessions`, `saved_sessions` and `worktrees`. Facet values
are capability-dependent, not a promise that every cross-product is valid.
Routing identifies each role's primary and fallback models; cost/speed
estimates use a 1–5 scale and are `null` when unavailable. A missing default
catalog is reported as `catalog.state: "missing"`, with `init_argv` and
`generate_argv` recovery commands (`code generate init`, then `code generate`);
an explicitly configured unreadable or invalid catalog fails instead.

`suggest` requires a nonblank prompt, supplied either with `--prompt` or as
positional text after the options, never both. It requires hosted catalog
routing and the local evaluator (`CODE_EVAL_MODEL`; `CODE_OLLAMA_ENDPOINT`
must be a loopback HTTP URL without credentials, query or fragment). There is
no cloud fallback. The response contains `evaluator`, an `actions` array of
`{"key":"…","value":"…"}` changes, and the complete resulting `selection`.
`--selection` supplies the starting state, not pinned constraints: the
suggestion may change it. Invalid or unavailable proposed choices and
incomplete or failed evaluator responses fail rather than producing a usable
proposal. A proposal does not apply itself, launch anything, or persist dial
state. Review its selection, optionally preview it with `inspect --selection`,
then pass that object to `launch --selection` yourself.

Both commands use `schema_version: 1`, `observation: "one_shot"` and
`observed_at` as a UTC RFC3339 timestamp (possibly with fractional seconds).
Their public field names are **snake_case**; session/worktree timestamps are
also RFC3339 strings. These are observations, not a continuously live feed:
`lock_held` means a session registry lock was held when read, while
`not_observed` is not proof that a process is dead and `unknown` can mean the
registry is disabled. Saved sessions are metadata-only. Inspection does not
persist dial choices, but uses the normal registry readers, including stale
record cleanup.

### Usage and account JSON

```bash
code usage
code accounts                     # same as accounts list
code accounts list
code accounts presets list
```

These commands output JSON directly; there is no `--json` flag. Unlike
`inspect`/`suggest`, accounts and usage use **camelCase**, `schemaVersion: 1`,
and integer **Unix seconds** for times (`observedAt`, `requestedAt`,
`resetsAt`, `blockedUntil`, restriction `until`, `faultAt`, `expiresAt`).
Do not treat these two schema families as identically cased or timestamped.
Errors go to stderr with a nonzero exit status.

`usage` takes no arguments. It refreshes the broker snapshot once and
reconciles it with `CODE_USAGE_CACHE`; a successful usage-and-account refresh
can update that cache, but does not change selections. Check `status`
(`fresh`, `partial`, `stale`, `failed`), `usageRefresh`, `accountRefresh`,
provider/account/window statuses and each window's `observedAt`, not just the
request time. Cache fallback preserves observation ages. Missing windows have
`status: "missing"` with zero observation/reset times, not freshly measured
zero usage. Disabled accounts remain visible; provider buckets summarize only
the selected launch pool. Reset credits and provider balances appear when
available. A wholly failed snapshot can still be emitted as JSON before the
command exits nonzero; stale or partial data is explicitly labeled.

`accounts list` and `accounts presets list` return the same full projection:
`operation`, `observedAt`, `activePreset`, `accounts`, `presets` and
`manualDisabled`. Each account has a public `(provider, identityKey)`
reference, `selectable`, `enabled`, `blocked` and scoped `restrictions`.
Enabled means included in the account pool, not necessarily usable for every
model tier; a broker restriction may still block it. Credentials, internal
credential IDs and raw broker error chains are not exposed. Public identities
and optional email addresses are still personal data.

### Explicit account mutations and login

Use the exact `provider` and `identityKey` returned by `accounts list`, not a
display email or internal credential ID. `PROVIDER` and `IDENTITY_KEY` below
are placeholders for those returned values:

```bash
code accounts set --provider PROVIDER --identity IDENTITY_KEY --enabled false
code accounts set --provider PROVIDER --identity IDENTITY_KEY --enabled true
code accounts presets create --name Focus --disabled '[{"provider":"PROVIDER","identityKey":"IDENTITY_KEY"}]'
code accounts presets update --name Focus --disabled '[]'
code accounts presets activate --name Focus
code accounts presets activate --name Manual
code accounts presets delete --name Focus
code accounts clear-blocks --provider PROVIDER --identity IDENTITY_KEY
code accounts login --provider anthropic
```

Mutations take effect immediately; there is no confirmation prompt or `--yes`
flag. `set` requires literal `true` or `false` and edits the active selection
(including an active named preset). Presets store **disabled** references:
`[]` excludes nobody. Create requires a new name and activates it; update
requires an existing name and replaces its disabled list. Names are matched
case-insensitively; `Manual` is reserved. Deleting the active preset preserves
its current pool as Manual rather than broadening it.

Selection/preset writes require `CODE_AUTH_ACCOUNT_STATE`, a successful
account snapshot and valid existing state. They lock and re-read the state,
validate account references, and persist with a private atomic replacement.
Invalid state or unknown identities/presets fail instead of silently resetting
to a wider pool. A nonexistent state file starts at Manual; an unset path is
allowed for reads but not selection writes. Returned JSON describes the
resulting selection, not a continuously refreshed account view.

`clear-blocks` is a broker mutation, not a selection change. Its JSON
acknowledges the account reference and `cleared: true`; it does not guarantee
new quota or a fresh usage read. Run `code usage` afterward. An upstream limit
can recreate the block on the next request.

`login` is deliberately **not JSON**: it connects the real terminal's stdin,
stdout and stderr to `omp auth-broker login <provider>` (using `CODE_OMP`).
`CODE_AUTH_LOGIN_VIA=user@host` adds the existing `--via` login handoff.
Only OAuth providers are accepted; browser authorization and terminal
interaction stay in that existing login flow, never in a headless credential
API. API-key enrollment still uses the operator's secure broker tooling.
Refresh with `code accounts list` after login.

## models.yml columns

| column | meaning |
| --- | --- |
| `pool` | `O` (OpenAI/Codex), `A` (Anthropic), or `D` (DeepSeek). `O` and `A` must fill tiers 1..3; `D` is optional — one verified model is enough, missing tiers borrow the nearest rung |
| `tier` | position on the pool's capability ladder. `1` cheap, `2` regular, `3` smart, and an optional `4` — a fourth rung the model dial's `elite` notch reaches. Ladder depth is per pool, and a provider shipping a fourth model needs no code change to light its own `elite` up: Anthropic's is `claude-fable-5`, OpenAI's `gpt-6-astra`. `0` is off the ladder entirely: the fast idle-bucket model the `spark` toggle drains |
| `bucket` | the quota window the model draws — drives the usage meter |
| `image` | `false` marks a text-only model, which the vision role then avoids |

The `elite` notch is offered only on lanes whose **lead** pool has a tier-4
rung. That is not the same as "any pool in the lane" — the deliberative bump
already gives plan/slow/reviewer the top rung at `smart`, so on a lane
led by a three-rung pool `elite` would render a block identical to `smart`.

`code generate init` ranks a pool's ladder by price, so it needs one for every
model. omp's model table lags a launch unevenly — a brand-new flagship arrives
at `$0` under its own provider while a reseller row of the same model
(openrouter's `openai/gpt-6-astra`) carries the price from day one — and a
scaffold used to drop such a model without a word. It now fills the blank from
the same model's priced row under any other provider omp lists (exact bare id,
highest price where resellers disagree), and names any model no row prices in a
warning at the top of `models.yml` so you can write the rung in by hand.

All three scaffold probes (`models`, `usage`, and the mandatory live `bench`)
use `CODE_OMP` when set, otherwise `omp` on PATH, just like a trusted launch.
An invalid explicit runtime is an error, not permission to probe a different
installation. `code generate init` and first-run onboarding make model calls;
`code generate refresh` also does by default. `code generate` only re-renders
an existing catalog.

The generated grid covers OMP's model roles and bundled task agents, not a
historical agent inventory. The retired bundled `librarian` route is no longer
generated or included in cost/speed estimates. Re-render an existing catalog
with `code generate` to remove that old automatic row; Code does not rewrite
stored catalogs or delete user agent definitions on startup. Explicit custom
agent rows in a supplied catalog remain supported: a `●`-marked row, including
one named `librarian`, still supplies its `task.agentModelOverrides` entry.
The override is a quoted native alias (`librarian: '@librarian'`), with its
selector and thinking suffix defined once in `modelRoles.librarian`.
OMP must retain that role identity when spawning: copying the concrete lead
loses it and makes the child inherit `retry.fallbackChains.default`, even if
another role happens to name the same lead. A generated lead-only role receives
an explicit empty chain (`[]`), expressing that it must not inherit another
role's chain. OMP 18.1.14 has a separate child-session role-persistence defect,
so this intent is not yet a strict runtime guarantee when models are shared
([#142](https://github.com/atyrode/code/issues/142)).
These are one-shot launch overlays, not a migration of persistent OMP settings
or previously stored immutable Code profile revisions.

## Refreshing curated model facts

```sh
code generate refresh --models-file PATH
code generate refresh --models-file PATH --skip-bench
code generate refresh --models-file PATH --bench-json saved-chat-bench.json
```

`refresh` updates an existing catalog's `cost_in`, `cost_out`, `context`,
`thinking`, `speed` and `ttft` (adding a missing `ttft` when measured). It preserves
membership, model IDs, pools, tiers, buckets, image overrides, comments and custom
fields. It does not regenerate tiers: **`code generate init --refresh` replaces
the scaffold**, while `code generate` renders the catalog after editing.
Without `--models-file`, refresh uses the same default models path as `init`.

**The default benchmark makes live, potentially paid model calls.** Collection
uses `CODE_OMP` (otherwise `omp` on PATH), the provider registry and native
`bench --profile chat` with Code's short harmless prompt. `--runs N` defaults to
2 requests per curated model; `--max-tokens N` defaults to 256. Both must be
positive. Metadata comes from `omp models --json`, including priced reseller
rows when a provider's own price is unavailable. Thinking capabilities retain
gaps rather than advertising unsupported intermediate levels.

`--skip-bench` makes no benchmark calls and retains cached speed/TTFT.
`--bench-json PATH` instead reads saved native `omp bench --profile chat --json`
output; it must contain its declared number of successful runs, with valid
per-run measurements and aggregate means. These options are mutually exclusive. Both still
collect current metadata. Speed prefers streaming `generationTps`; TTFT is
stored in seconds. A failed run cannot be hidden by an average of successes.

The single `refreshed` date advances only when metadata and every requested
benchmark measurement are complete. Metadata-only, failed and partial runs
retain the previous date (or leave it absent). Available valid facts can still
be saved while unavailable fields retain their cached values. Exit status is
`0` for a full refresh or complete metadata with explicit `--skip-bench`, `1`
for incomplete facts/collection failure, and `2` for invalid arguments or
catalog shape. Invalid metadata envelopes leave the file unchanged. Saving is
atomic, preserves file permissions and refuses to overwrite a catalog changed
during collection.

Code owns this generic headless refresh command; catalog curation, scheduling
and deployment belong to each consumer. Dotfiles' existing refresh integration
has not migrated merely because this command exists: that consumer cutover
waits for a published Code binary. This command neither activates a host nor
publishes a release.

## Dials that set omp's own switches

Most dials pick models, so they select a pre-computed routing block. Four do
not: they choose a value for a switch omp already owns, and this tool's only job
is to put that value where omp reads it. None of them appears in the combo id,
so the generated grid is byte-identical whatever they are set to.

In the generator they sit behind a `more` row at the end of the dial list,
closed on every open: `→` on that row opens it, `←` closes it, and while it is
closed the row names what it hides and spells any switch away from its default
(`prewalk on`, `fallback off`), so nothing behind the fold can change a launch
without saying so on screen. The fold is a view state — a `d` reset turns the
switches back but leaves it open, and it is never persisted with the dials.

| dial | omp surface | effect |
| --- | --- | --- |
| `fast` | `tier:` overlay key, per provider | buys every priority service tier the lane's pools sell. Offered on exactly those lanes: a pool declares one by setting `ServiceTier` in the provider registry, and nothing else needs editing |
| `prewalk` | `prewalk.enabled` + `task.prewalk` | hands the run to the `smol` role at the first edit once the plan's todo list exists. Main session and spawned task agents both move — half a run on the cheap model would not be what the label says. The target needs no setting: omp defaults it to `smol`, which the grid already routes |
| `planyolo` | `--plan-yolo` argv flag | starts read-only in plan mode, auto-approves the plan on the model's first resolve call, then implements. omp exposes this on the command line only, so it rides argv rather than the overlay |
| `fallback` | `retry.modelFallback` | on by default. Off keeps every role on its lead: the overlay writes `modelFallback: false` and carries no `fallbackChains` — omp gates every model switch it makes on retry (the error path, the usage-aware preflight, the advisor's) on that one key, so the chains would be inert and are left out rather than shown. `retry.enabled` stays on: same-model retries are not fallback. The account/broker fallback is a separate system and is untouched. The routing preview shows leads only while it is off, and the `f` chain toggle gives way to a note saying the chains are disabled for this launch |

A forwarded flag of your own still wins: the dials' flags are inserted before
whatever you passed through.

## Glyphs and fonts

The facet dials are labelled with Nerd Font Private Use Area codepoints, so a
terminal without a patched font renders them as tofu boxes. `code` cannot fix
that for you: font selection belongs to the terminal emulator, and a
Nix/goreleaser package of a TUI binary has no way to reach into it. Installing
the font is the operator's business — [dotfiles](https://github.com/atyrode/dotfiles)
does it via `nerd-fonts.symbols-only` in the `agent-tools` profile.

What `code` does provide is a fallback, so an unpatched terminal is legible
rather than broken:

| `CODE_SYMBOLS` | glyphs |
| --- | --- |
| unset, or `nerd` | Nerd Font icons (the default — every existing install renders these) |
| `unicode` | plain BMP symbols (`⇄ ⚙ ✦ ◎ ↓ ›`) that any modern monospace font carries |

`CODE_FACET_GLYPHS` ("`model=*,lane=>`") overrides individual keys on top of
whichever preset resolved.

omp has its own `symbolPreset` setting with the same three values, and `code`
deliberately does **not** read it: omp reports `unicode` on a machine where
nobody ever set it, so the value cannot distinguish a deliberate choice from
omp's default — and taking it at face value silently restyled a machine whose
operator had asked for nothing. Set `CODE_SYMBOLS` where you set the font.

## Keys worth knowing

| key | effect |
| --- | --- |
| `f` | primary lead ⇄ full fallback chains (leads only, and the cue says why, while the `fallback` dial is off) |
| `n` | short model keys ⇄ full catalog model ids — a sanity check on what the current dials actually route to |
| `i` | short ⇄ full account ids in the Usage panel |
| `d` | reset the dials to defaults |
| `?` | the rest of the key map |

`n` is a view preference: it defaults to off and is never persisted into the
selection state, because it changes nothing about routing.

## State on disk

Everything `code` persists lives under its own state root — `$XDG_STATE_HOME`,
or `$HOME/.local/state` when that is unset — in `code/`:

| path | contents | override |
| --- | --- | --- |
| `code/selection.json` | the dial positions | `CODE_SELECTION_STATE` (`off` disables) |
| `code/sessions` | live session records, used for liveness | `CODE_SESSION_STATE` (`off` disables) |
| `code/worktrees` | one JSON record per session worktree | `CODE_WORKTREE_STATE` |
| `code/wt` | the session worktrees themselves | `CODE_WORKTREE_DIR` |
| `code/profiles` | immutable profile revisions the engine launches under | `CODE_PROFILE_STATE` |

`CODE_WORKTREE_DIR` must be an absolute path (a leading `~` is expanded); a
relative value is ignored, because the process chdirs into the worktree it
creates and a relative root would not name the same directory afterwards.

`code/profiles` holds the immutable profile revisions `code engine
--configure` mints and `code engine` launches under, one directory per
profile id holding `NNNNNNNN.json` files that are written once and never
rewritten; `CODE_PROFILE_STATE` names the directory outright. A profile
directory laid out the same way at some other path — an earlier per-client
location, another machine's store — is carried over with `code engine
--import-profiles DIR`: every revision is copied verbatim with its number
intact, a revision already present with the same content is skipped, and one
present with different content refuses the import, so a reference a client
recorded keeps meaning exactly what it meant. Nothing is migrated on its own;
the old directory is untouched until the operator names it.

### Saved omp sessions

`code ls` and `code wt` also read OMP's persisted sessions, which are OMP's
state, not `code`'s. On Linux/macOS, OMP uses
`$XDG_DATA_HOME/omp/sessions` when `$XDG_DATA_HOME/omp` already exists;
a named profile independently uses
`$XDG_DATA_HOME/omp/profiles/<name>/sessions` when that profile root exists.
Merely setting `XDG_DATA_HOME` does not migrate or select a nonexistent root.
Otherwise sessions remain under `~/.omp/agent/sessions` or
`~/.omp/profiles/<name>/agent/sessions`, with `PI_CONFIG_DIR` selecting the
legacy config root. An explicit `PI_CODING_AGENT_DIR` overrides the default
profile's agent directory, not a named profile's data root.

Trusted launches inherit the environment's profile: `OMP_PROFILE` takes
precedence over `PI_PROFILE`, including when explicitly empty. Forwarded
`--profile` remains stripped; Code does not force the default profile.
Discovery includes effective native roots and historical default/profile
roots so migration does not hide old transcripts. A forwarded `--session-dir`
replaces that inventory with only the named directory. Untrusted launcher
state is never searched or resumed. `omp config path` reports a **config**
directory, not the session data root.

Discovery decodes only allowlisted header metadata in at most two leading
JSONL records within 64 KiB, accepting either title/session order and reordered
JSON keys. It stops at the first non-header record; it never searches messages
for a title or prompt. OMP's native session listing/completion reads messages
(and normal listing can recover backups), so Code does not call it for this
metadata-only, non-mutating inventory. Results are ranked: the current
directory's own sessions, then the rest of the repository (every worktree
`git worktree list` or `code wt` knows), then parent or child directories,
then everything else, newest activity first within a rank.

A session is marked `live` when a record in `code/sessions` holds its lock in
the same directory and this is the transcript that process has written most
recently since it started — or, when it has written nothing yet, the id it
recorded as its `--resume` target; anything else is `interrupted`.
`code wt resume <worktree|id>` resolves an id or unique prefix across every
trusted root to exactly one session, refuses an ambiguous one by listing the
candidates, and launches `omp --resume <id>` (with `--session-dir` when the
session lives outside the default root) in the recorded directory, through the
same trusted launch path as a fresh session. A directory that no longer exists
is reported; nothing is created, pruned, or reset.

### Why `code/wt` and not omp's `~/.omp/wt`

Session worktrees used to be created inside omp's own worktree directory, which
`omp worktree list` enumerates and `omp worktree clear --all` force-deletes in
full — live entries included. omp cannot know better: it has no view of `code`'s
session registry, so it cannot tell a running session's worktree from one of its
own abandoned task worktrees. One `omp worktree clear --all` was enough to
delete a live session's tree and its uncommitted work.

The two features are not the same thing and neither replaces the other. omp's
worktrees are in-session, per-subagent task isolation; `code`'s are pre-launch,
whole-session operator branches on a `code/<adj>-<color>-<animal>` branch. So
`code` moved its worktrees into its own state root and stopped reading omp's
`OMP_WORKTREE_DIR` entirely.

Worktrees created by an older build are still recorded and still listed —
`code wt` marks their `ROOT` column `legacy` — and `code wt rm <name>` or
`code wt prune` retires them. Nothing is moved on disk: they are your git
worktrees, and a launcher that silently relocated them would be committing the
same unannounced mutation this change exists to prevent. To see what an old
build left behind:

```bash
# every directory still in omp's root that is checked out on a code/ branch
for d in ~/.omp/wt/*/; do
  b=$(git -C "$d" symbolic-ref --quiet --short HEAD 2>/dev/null)
  case "$b" in code/*) echo "$d $b" ;; esac
done
```

The `code/` branch check is what separates them from omp's own task worktrees,
which share the directory and are omp's to clear.
