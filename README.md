# code

**Mission control for your coding agents.**

> There can only be one `code` on your machine. If you, too, never plan to
> run VS Code again — the name just freed up.

![the code generator](docs/screenshot.png)

`code` is a launch pad for [oh-my-pi](https://github.com/can1357/oh-my-pi),
the AI coding agent. Instead of starting every session on the same defaults,
you dial in what the task in front of you actually needs:

- **generator** — a few dials: which model pool, how capable a model, how much
  thinking, how much reviewing.
- **routing** — a live preview of exactly which model would handle which role
  with the current dials.
- **usage** — your provider quotas at a glance, so you spend the scarce
  buckets on purpose.

Press `enter` and `code` launches oh-my-pi with that setup, as a one-shot
overlay — your omp config is never modified.

It's made for people who run oh-my-pi with **both Anthropic and OpenAI**:
the whole point is deciding, per task, how to blend the pools and which
quota to spend. A DeepSeek API key adds a third, pay-as-you-go pool — its
own `ds` lanes, a live balance readout in Usage, and a relief tail at the
end of the heavyweight fallback chains for when the metered windows are
drained. With a single provider you can still launch, but the dials lose
most of their meaning.

## Usage

```bash
code
```

That's the whole manual. Dial what the task needs, press `enter`, and you're
in an oh-my-pi session routed exactly as previewed.

Everything after `code` belongs to oh-my-pi — it's carried verbatim into the
session you launch:

```bash
code "fix the failing tests"   # launches omp with that as its first message
code --continue                # dial, then pick up your last omp session
```

A few words `code` keeps for itself: `generate` (the [catalog
subcommand](docs/configuration.md)), `session` and its `ls` shorthand,
`worktree` and its `wt` shorthand, and `--profile` (routing is code's job — a
forwarded `--profile` is replaced).

Every session you launch is recorded while it runs, so the ones you walked away
from are findable rather than merely suspected:

```bash
code ls                                 # live sessions: age, launcher, directory
code session reap --superseded          # dry run: what is on a stale build
code session reap --older-than 3d --yes # retire them, whole process tree
```

`reap` prints and exits unless you pass `--yes`, and always takes the session's
whole process tree — language servers, browsers, and workers included, so they
are not orphaned onto init while still holding their memory.

Inside a repository, press `w` before launching to start the session on a fresh
`code/<adj>-<color>-<animal>` branch in its own linked worktree. The toggle is
off by default. A pristine worktree is removed when the session exits; changes
or commits keep it for recovery:

```bash
code wt                    # list session worktrees and their state
code wt remove <name>      # remove an idle, pristine worktree
code wt prune              # dry-run cleanup; add --yes to remove
```

## Features

- **Dials, not config files** — a provider **lead** dial with a led/only
  blend child (scales past two pools without overflowing), notched sliders
  for model tier and thinking depth, advisor level, plus the spark/fable
  toggles; every combination maps to a pre-computed routing. Optional pools
  plug in as their own lanes, and a **relief** dial decides whether drained
  metered chains may spill into the pay-as-you-go pool.
- **Hosted or local** — an optional runtime broker can advertise only the local
  targets this machine supports; selecting one delegates first-use setup and
  launch without mixing cloud credentials into the session.
- **Live preview** — see which model leads every role, and its fallback
  chain, before anything runs.
- **One-shot overlays** — each launch is an ephemeral `--config`; your omp
  configuration is never written.
- **Prompt → profile** — `ctrl+o`, describe the task, a small local model
  rates its difficulty and sets the dials (optional, needs
  [ollama](https://ollama.com); the prompt is forwarded into the session).
  Suggestions are quota-aware: a lane whose lead pool is maxed falls to a
  sibling with headroom, and a low DeepSeek balance stops proposals from
  spending it.
- **Usage at a glance** — quota bars and reset countdowns per provider,
  before you spend the scarce bucket.
- **Account presets** — choose broker accounts and save reusable selections (`v`).
- **Cost & speed meters** — every dial change reprices the session; DeepSeek
  rungs are priced by the clock during its off-peak discount window.
- **Guided first run** — no catalog? `code` builds one from your omp,
  interactively; `code generate` scripts the same thing.
- **Argument passthrough** — `code <anything omp understands>` just works.

## Install

**Grab a [release binary](https://github.com/atyrode/code/releases)** — one
static file, nothing else to install:

```
curl -fsSL https://github.com/atyrode/code/releases/latest/download/code-linux-amd64.tar.gz | tar xz code
```

(swap `linux-amd64` for `linux-arm64`, `darwin-amd64`, or `darwin-arm64`)

**Or with Nix** — the same binary, with oh-my-pi bundled if you want it:

```
nix run github:atyrode/code            # just code
nix run github:atyrode/code#with-omp   # code + a pinned omp on PATH
```

**Or, for Gophers:** `go install github.com/atyrode/code@latest`

Unless you took `#with-omp`, you need
[oh-my-pi](https://github.com/can1357/oh-my-pi) (`omp`) installed — `code`
launches it, it doesn't replace it. Authenticate providers directly with OMP
using `omp auth-broker login` before running `code`.

Then just run `code`. The first run notices there's no routing catalog yet
and walks you through building one from your omp's model list — it shows you
which model it picked for each rung, you sanity-check, press enter, done.
That guided run is for plain installs: the
[dotfiles](https://github.com/atyrode/dotfiles) wrapper always exports
`CODE_GENERATED` at a pre-baked catalog, so `code` never offers to build one
there — you re-render with `code generate` instead.

The same machinery is scriptable as `code generate init` (scaffold the models
file) and `code generate` (re-render the catalog after you edit it).

## More

- [Configuration](docs/configuration.md) — every key and environment variable
- [Status & caveats](docs/status.md) — what works out of the box, what is
  still shaped by the author's setup, and where this is going

[MIT](./LICENSE) — extracted from
[atyrode/dotfiles](https://github.com/atyrode/dotfiles).
