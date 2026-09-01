# Status & caveats

`code` is an opinionated personal tool, published because it's useful. It was
built for a heavily managed multi-provider oh-my-pi setup
([atyrode/dotfiles](https://github.com/atyrode/dotfiles)) and it degrades
cleanly without that infrastructure: every feature that isn't configured
simply hides itself (see [configuration](./configuration.md)).

If you run omp with more than one provider subscription and care which model
chain answers which task, this tool is for you. If you run omp on one
provider with defaults, you probably don't need it.

## The catalog

The dials map to pre-generated routing blocks. `code generate init` scaffolds
a models file from your own omp instance (`omp models --json`, plus
`omp usage --json` to spot the tier-scoped quota bucket that marks the spark
model) and `code generate` renders the catalog from it — see the README
quickstart. The tier assignments `init` derives (newest model per family,
then ranked by thinking ceiling, context and price) still deserve a human look.

What no longer needs a caveat: `init` probes every candidate with `omp bench`
before it can become a rung, and that is mandatory rather than a flag. omp lists
models an account cannot actually call and nothing in the metadata says so —
`claude-mythos-5` reports the fable models' exact price, context window and
thinking range, and 404s here — so anything the provider disowns is dropped, as
is anything missing from the report. The same pass supplies the real speed/ttft,
which used to be an identical placeholder pair on every model, making the speed
meter move with the thinking dial and nothing else. It is one timed request per
model, so `init` takes a minute and the figures are a single sample rather than a
steady benchmark. A verified file is marked `probed: true`; `generate` refuses
one that is not.

The probe sorts a failure into three outcomes, because they are not the same
thing. A model the provider says does not exist is dropped. A model the provider
refuses because the *client* is too old is also dropped, but named in the
scaffold's header with the version the provider asked for — `claude-fable-5-1`
is entitled on this account today and still uncallable, because omp advertises
Claude Code 2.1.246 and Anthropic wants 2.1.251 for it. Anything else is
inconclusive, and inconclusive refuses the whole scaffold rather than certifying
a ladder around a model that never answered.

## Other honest caveats

- oh-my-pi releases near-daily, and the `omp models --json` / `omp usage --json`
  / `omp bench --json` schemas the generator reads carry no
  stability guarantee — nor does the auth broker's snapshot/usage API the
  panel draws from. A scheduled compatibility check is planned:
  [#3](https://github.com/atyrode/code/issues/3).
- The quota bucket a model draws from is declared in the catalog (`bucket:`)
  and the TUI prefers that; guessing it from the model family is now only the
  fallback for catalogs that declare none. Model-family colouring is still
  name matching that reflects the author's provider mix. Both fail soft.
- The Usage panel draws a tier-scoped quota window only while some catalog model
  still draws from that bucket. Providers do not stop reporting a window they
  have retired — Anthropic's separate Fable window is still in the payload,
  reading 0% and `ok` indefinitely — and a row nothing can ever spend is noise.
  Windows that are not tier-scoped are the account's ordinary quota and always
  render, and a catalog-less run knows no buckets so it shows everything.
  Routing is unaffected either way: a bucket no model declares strikes no rung.
- The local model lane (Babel's configuration ceremony) offers whatever the
  daemon reports and verifies only that the endpoint answers and still serves
  the chosen tag. Nothing probes whether that model can carry an analysis — the
  catalog's rungs are `omp bench`-verified, these are not — so a 1B model is as
  selectable as a 30B one, and the resulting findings are as good as the model.
- Deliberately not ours, audited against omp 18.1.2: retry, model fallback,
  quota enforcement, sandboxing of an ordinary session, session resume, and
  worktree isolation for spawned subagents are all omp's, and nothing here
  reimplements them — every runtime concern is a freshly exec'd `omp`. What is
  ours is the pre-launch estimate omp cannot make (the cost/speed meters, which
  score a facet combination omp has no concept of), the capability ladder
  (`omp models --json` carries no tier or ranking field), the reachability
  probe (omp lists models an account cannot call and says nothing about it), and
  whole-session operator worktrees plus the cross-launch session registry, which
  omp has no command for.
- Those worktrees used to live in `~/.omp/wt` — omp's own directory, which
  `omp worktree clear --all` empties without knowing about this tool's liveness
  records. They now live under `code`'s state root; `code wt` still lists any
  left behind, marked `legacy`, so the existing remove/prune flow can clear
  them.
- The Usage panel still reads the auth broker's snapshot directly and does not
  consume omp's own `capacity`, `disabledCredentials`, or `accountsWithoutUsage`
  fields. That is a real gap, not a decision: omp reports *why* a credential is
  down (an expired OAuth grant, say) and this panel can currently only infer
  "unauthed" from an absent report. Until it consumes them, an account that omp
  has disabled renders as merely silent.

## Built on

[cli-kit](https://github.com/atyrode/cli-kit) — the shared palette, layout
primitives, and the `ctrl+o` PromptBox.
