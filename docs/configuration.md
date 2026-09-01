# Configuration

## models.yml columns

| column | meaning |
| --- | --- |
| `pool` | `O` (OpenAI/Codex), `A` (Anthropic), or `D` (DeepSeek). `O` and `A` must fill tiers 1..3; `D` is optional — one verified model is enough, missing tiers borrow the nearest rung |
| `tier` | position on the pool's capability ladder. `1` cheap, `2` regular, `3` smart, and an optional `4` — a fourth rung the model dial's `elite` notch reaches. Ladder depth is per pool: Anthropic ladders to 4 today, Codex to 3, and a provider shipping a fourth model needs no code change to light its own `elite` up. `0` is off the ladder entirely: the fast idle-bucket model the `spark` toggle drains |
| `bucket` | the quota window the model draws — drives the usage meter |
| `image` | `false` marks a text-only model, which the vision role then avoids |

The `elite` notch is offered only on lanes whose **lead** pool has a tier-4
rung. That is not the same as "any pool in the lane" — the deliberative bump
already gives plan/slow/designer/reviewer the top rung at `smart`, so on a lane
led by a three-rung pool `elite` would render a block identical to `smart`.

## Dials that set omp's own switches

Most dials pick models, so they select a pre-computed routing block. Three do
not: they choose a value for a switch omp already owns, and this tool's only job
is to put that value where omp reads it. None of them appears in the combo id,
so the generated grid is byte-identical whatever they are set to.

| dial | omp surface | effect |
| --- | --- | --- |
| `fast` | `tier:` overlay key, per provider | buys every priority service tier the lane's pools sell. Offered on exactly those lanes: a pool declares one by setting `ServiceTier` in the provider registry, and nothing else needs editing |
| `prewalk` | `prewalk.enabled` + `task.prewalk` | hands the run to the `smol` role at the first edit once the plan's todo list exists. Main session and spawned task agents both move — half a run on the cheap model would not be what the label says. The target needs no setting: omp defaults it to `smol`, which the grid already routes |
| `planyolo` | `--plan-yolo` argv flag | starts read-only in plan mode, auto-approves the plan on the model's first resolve call, then implements. omp exposes this on the command line only, so it rides argv rather than the overlay |

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
| `f` | primary lead ⇄ full fallback chains |
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

`CODE_WORKTREE_DIR` must be an absolute path (a leading `~` is expanded); a
relative value is ignored, because the process chdirs into the worktree it
creates and a relative root would not name the same directory afterwards.

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
