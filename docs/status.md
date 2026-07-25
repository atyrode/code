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
`omp usage --json` to spot the tier-scoped quota buckets that mark the spark
and elite models) and `code generate` renders the catalog from it — see the
README quickstart. Two
honest limits: the tier assignments `init` derives (newest model per family,
then ranked by thinking ceiling, context and price) deserve a human look, and
the speed/ttft numbers it writes are placeholders unless you ask for
measured ones. `code generate init --bench` fills both from `omp bench --json`
— time to first token and output tok/s, one real API call per model, live
credentials required — and drops any model whose probe fails, which is the only
check that catches a model omp lists but your account cannot actually call.
Without it every model carries the identical placeholder pair, so the speed
meter those numbers drive is model-invariant: it moves with the thinking dial
and nothing else.

## Other honest caveats

- oh-my-pi releases near-daily, and the `omp models --json` / `omp usage --json`
  (and, with `--bench`, `omp bench --json`) schemas the generator reads carry no
  stability guarantee — nor does the auth broker's snapshot/usage API the
  panel draws from. A scheduled compatibility check is planned:
  [#3](https://github.com/atyrode/code/issues/3).
- The quota bucket a model draws from is declared in the catalog (`bucket:`)
  and the TUI prefers that; guessing it from the model family is now only the
  fallback for catalogs that declare none. Model-family colouring is still
  name matching that reflects the author's provider mix. Both fail soft.

## Built on

[cli-kit](https://github.com/atyrode/cli-kit) — the shared palette, layout
primitives, and the `ctrl+o` PromptBox.
