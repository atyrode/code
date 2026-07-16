# Status & caveats

`code` is an opinionated personal tool, published because it's useful. It was
built for a heavily managed multi-provider oh-my-pi setup
([atyrode/dotfiles](https://github.com/atyrode/dotfiles)) and it degrades
cleanly without that infrastructure: every feature that isn't configured
simply hides itself (see [configuration](./configuration.md)).

If you run omp with more than one provider subscription and care which model
chain answers which task, this tool is for you. If you run omp on one
provider with defaults, you probably don't need it.

## The one real gap: the catalog

The dials map to pre-generated routing blocks (`CODE_GENERATED`). Today that
catalog is produced by a generator living in the author's dotfiles, from a
pinned model list — so out of the box, the routing preview is empty for
everyone else. Porting the generator into the tool as `code generate`
(reading your own `omp models --json`) is the top roadmap item:
[#1](https://github.com/atyrode/code/issues/1).

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
