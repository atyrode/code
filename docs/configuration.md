# Configuration

`code` needs no config file. Everything is a key inside the TUI or an
environment variable with a sane fallback.

## Keys

| Key | Action |
|---|---|
| `↑` `↓` | move between dials |
| `←` `→` | change the selected dial |
| `d` | reset all dials to defaults |
| `ctrl+o` | describe the task, let a local model set the dials |
| `enter` | launch oh-my-pi with the generated setup |
| `m` | launch plain managed omp (no overlay) |
| `u` | launch through a sandboxed omp, if you have one |
| `v` | manage broker account selections and presets |
| `p` / `f` / `s` | toggle routing panel / fallback chains / usage panel |
| `r` | refresh the usage panel now |
| `?` | expanded help |
| `pgup` / `pgdn` | scroll the routing preview |
| `q` | quit |

`↑↓←→` also answer to their vim aliases (`j`/`k`/`h`/`l`).

## Environment variables

| Variable | Purpose | Without it |
|---|---|---|
| `CODE_GENERATED` | path to the generated facet catalog (the routing blocks behind the dials) | `$XDG_DATA_HOME/code/generated.plain`, where `code generate` writes; if that's missing too, the TUI opens the guided first-run that builds it |
| `CODE_SELECTION_STATE` | file persisting your dial choices | choices reset each run |
| `CODE_SESSION_STATE` | directory recording live sessions for `code ls` / `code session reap`; `off` disables recording | `$XDG_STATE_HOME/code/sessions` — note this one defaults to a path rather than to disabled, so the registry works without wrapper changes |
| `CODE_OMP` | omp binary for trusted launches (`m` and `enter`) | `omp-managed`, then `omp` on PATH |
| `CODE_OMP_UNTRUSTED` | sandboxed omp for the `u` key | `ompu` on PATH, else the key is hidden and inert |
| `OMP_AUTH_BROKER_URL` | central auth broker behind the usage panel and the account picker (`v`); inherited from your omp environment | no fetch — the usage panel has nothing to show |
| `OMP_AUTH_BROKER_TOKEN` | bearer token for that broker | same: `code` only fetches when both the URL and the token are set |
| `OMP_AUTH_BROKER_SNAPSHOT_CACHE` | broker snapshot cache path; `code` never reads it, it only forwards it to the omp it launches | forwarded empty |
| `CODE_AUTH_VAULTS` | legacy vault manifest (inline JSON), consulted only when no `OMP_AUTH_BROKER_*` variable is set | the broker variables are the only source |
| `CODE_AUTH_VAULTS_FILE` | the same legacy manifest read from a file, when `CODE_AUTH_VAULTS` is empty | ditto |
| `CODE_AUTH_ACCOUNT_STATE` | file persisting your broker account selections and presets (`v`) | selections reset each run |
| `CODE_USAGE_CACHE` | file caching the last usage snapshot, so the panel opens on last-known numbers (marked stale) instead of blank | the panel starts empty and fills on the first fetch |
| `CODE_EVAL_MODEL` | ollama model tag for `ctrl+o` | `qwen2.5:3b` |
| `CODE_OLLAMA_ENDPOINT` | non-default ollama endpoint | `http://127.0.0.1:11434` |
| `CODE_FACET_GLYPHS` | override the Nerd Font dial glyphs | built-in glyphs |

`CODE_USAGE` and `CODE_OMP_RAW` are no longer read; the dotfiles wrapper still
exports them for older pinned builds. The usage panel now comes from the auth
broker (`OMP_AUTH_BROKER_URL` / `OMP_AUTH_BROKER_TOKEN`).

Provider authentication is owned by OMP, not `code`. Authenticate with
`omp auth-broker login` before launching `code`.

## The `code generate` subcommand

The dials are backed by a pre-rendered catalog. Building it is two steps, both
scriptable:

```
code generate init [--models-file OUT] [--refresh] [--from-json FILE]
code generate      [--models-file FILE] [--out FILE|-]
```

`init` scaffolds a models file from your own omp (`omp models --json`), keeping
the newest model per family and ranking it by thinking ceiling, context and
price — review what it derived. It also reads `omp usage --json`: a quota bucket
scoped to a model tier is how the spark and elite rungs are identified, and
without that report they are simply left empty. `generate` renders that file
into the catalog the TUI reads. Paths default to
`$XDG_CONFIG_HOME/code/models.yml` and `$XDG_DATA_HOME/code/generated.plain`
(`~/.config` and `~/.local/share` when those are unset); `--out -` prints the
catalog to stdout.

Every candidate is probed with `omp bench` before it can become a rung. This is
not optional and not a benchmark: omp lists models your account cannot actually
call, and no field distinguishes them — `claude-mythos-5` reports
`claude-fable-5`'s exact price, context window and thinking range, and 404s.
A model that does not return a passing probe is dropped, and a model missing
from the probe report entirely is dropped too, because unverified is not the
same as fine. One request per model, so expect `init` to take a minute. The
probe also supplies the real `speed`/`ttft` the meter reads.

A file whose models were all verified is marked `probed: true`, and `generate`
refuses to render one that is not — that marker is the only thing standing
between an unverified scaffold and live routing. Treat it as your attestation
rather than a permanent certificate: it describes the ids as they were written,
so if you edit an `id` by hand, re-run `init --refresh` (or satisfy yourself the
new one is callable) instead of leaving the old `true` in place.

| Flag | Effect |
|---|---|
| `--refresh` | re-derive the tiers over an existing models file instead of refusing to touch it. Without it `init` stops when the file already exists, so a scaffold from months ago keeps naming retired models. This is the line to run when a provider ships new models |
| `--from-json` | read the model list from a file instead of omp, and skip the probe. Offline inspection only: the output is marked `probed: false`, which `generate` rejects |

### The models file

Two top-level keys: `probed`, and `models:` mapping a short key to one model.

| Top-level field | Meaning |
|---|---|
| `probed` | must be `true` or `generate` refuses the file. `init` sets it after every model passed a live probe; an offline `--from-json` scaffold writes `false` |

Each entry under `models:`:

| Field | Meaning |
|---|---|
| `id` | the model id omp routes to |
| `pool` | `O` (OpenAI/Codex), `A` (Anthropic), or `D` (DeepSeek). `O` and `A` must fill tiers 1..3; `D` is optional — one verified model is enough, missing tiers borrow the nearest rung |
| `tier` | `1` cheap · `2` regular · `3` smart — the per-pool fallback ladder. `0` (a fast idle-bucket model the `spark` toggle drains) and `4` (a scarce elite the `fable` toggle leads with) are optional |
| `bucket` | the quota window this model draws from (`claude-main`, `claude-fable`, `codex-main`, `codex-spark`, `deepseek-main`). The TUI prefers it over guessing from the model family |
| `cost_in` / `cost_out` | dollars per 1M tokens; drives the cost meter |
| `speed` / `ttft` | output tok/s and seconds to first token; drives the speed meter. Measured by `init`'s probe — a single timed request each, so treat them as one sample rather than a stable benchmark |
| `context` | context window, in tokens |
| `thinking` | the levels the model really offers (see below) |
| `image` | omitted for image-capable models, which is most of them. `init` writes `image: false` only for a model omp reports as text-only, and the `vision` role then avoids it |

The `vision` lead follows the model dial: `fast`, `normal`, and `smart` select
tiers 1, 2, and 3 respectively. Mixed routing keeps GPT for fast and normal,
then prefers Claude's tier-3 model for smart, with the GPT tier-3 model in its
fallback chain. Any text-only rung is skipped.

The thinking scale is `minimal · low · medium · high · xhigh · max`. Write
`low→max` for a contiguous run, or a comma list when the model skips a level:
claude-opus-4-6 offers `low,medium,high,max` but not `xhigh`, and a range there
would claim a level the API rejects.

## The `ctrl+o` classifier

Any ollama daemon on loopback works:

```
ollama pull qwen2.5:3b
```

The model is loaded into memory only when you choose (`ctrl+l` inside the
box toggles residency); a one-off suggestion never leaves weights resident.
Small instruct models around 3B parameters work best — smaller ones rate
every task the same.
