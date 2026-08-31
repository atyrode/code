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
README quickstart. The tier assignments `init` derives (newest model per family,
then ranked by thinking ceiling, context and price) still deserve a human look.

What no longer needs a caveat: `init` probes every candidate with `omp bench`
before it can become a rung, and that is mandatory rather than a flag. omp lists
models an account cannot actually call and nothing in the metadata says so —
`claude-mythos-5` reports `claude-fable-5`'s exact price, context window and
thinking range, and 404s here — so anything that does not come back with a clean
probe is dropped, as is anything missing from the report. The same pass supplies
the real speed/ttft, which used to be an identical placeholder pair on every
model, making the speed meter move with the thinking dial and nothing else. It
is one timed request per model, so `init` takes a minute and the figures are a
single sample rather than a steady benchmark. A verified file is marked
`probed: true`; `generate` refuses one that is not.

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
- The local model lane (Babel's configuration ceremony) offers whatever the
  daemon reports and verifies only that the endpoint answers and still serves
  the chosen tag. Nothing probes whether that model can carry an analysis — the
  catalog's rungs are `omp bench`-verified, these are not — so a 1B model is as
  selectable as a 30B one, and the resulting findings are as good as the model.

## Built on

[cli-kit](https://github.com/atyrode/cli-kit) — the shared palette, layout
primitives, and the `ctrl+o` PromptBox.
