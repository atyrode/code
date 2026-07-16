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
a models file from your own omp instance (`omp models --json`) and
`code generate` renders the catalog from it — see the README quickstart. Two
honest limits: the tier assignments `init` guesses from price deserve a human
look, and the speed/ttft numbers it writes are placeholders (they only drive
the TUI's speed meter) until you measure and update them.

## Other honest caveats

- oh-my-pi releases near-daily, and the `omp models --json` /
  `omp usage --json` schemas the usage panel and (future) generator rely on
  carry no stability guarantee. A scheduled compatibility check is planned:
  [#3](https://github.com/atyrode/code/issues/3).
- Some quota heuristics (bucket names, model-family colouring) reflect the
  author's provider mix. They fail soft.
- A Nix flake with oh-my-pi baked in (`nix run` and it just works) is
  planned: [#2](https://github.com/atyrode/code/issues/2).

## Built on

[cli-kit](https://github.com/atyrode/cli-kit) — the shared palette, layout
primitives, and the `ctrl+o` PromptBox.
