# code

> Everyone's PATH has room for exactly one `code`. If you, too, never plan to
> run VS Code again — congratulations, the name just freed up.

`code` is a facet-dial launcher for [oh-my-pi](https://github.com/can1357/oh-my-pi):
a full-screen TUI where you dial **what the task needs** — lane (which provider
pool), model tier, thinking level, advisor depth, plus a few toggles — preview
the exact model-routing chain that produces, then hit Enter. It writes an
ephemeral omp config overlay and `exec`s `omp` with it. Your omp config is never
touched; every launch is a one-shot, reviewable overlay.

It also has:

- **`ctrl+o` — prompt → profile.** Describe the task; a small local model
  (ollama, `qwen2.5:3b` by default) rates its difficulty and dials the facets
  for you, live-previewed, `enter` to keep / `esc` to revert. The prompt is
  forwarded to the launched session as its first message. Fully optional — no
  daemon, no feature, everything else works.
- **A live usage panel** — provider quota at a glance before you pick a lane.
- **Auth vaults** — isolated provider identities you can cycle between
  (`a`/`v`). Dormant unless configured.
- **`u` — untrusted launch** through a sandboxed omp, if you provide one.

## Honest positioning

This is an opinionated personal launcher, published because it's useful — built
for a heavily managed multi-provider omp setup ([atyrode/dotfiles](https://github.com/atyrode/dotfiles)),
and it degrades cleanly without that infrastructure: no vault manifest → single
identity, no usage command → panel hidden, no ollama → no `ctrl+o`, no sandbox
binary → no `u`. If you run omp with more than one provider subscription and
care which model chain answers which task, this is for you.

## Requirements

- [oh-my-pi](https://github.com/can1357/oh-my-pi) (`omp`) on PATH — `code` is a
  launcher *for* it, not a replacement.
- A **facet catalog** (see Caveats below).
- Optional: an [ollama](https://ollama.com) daemon on loopback with a small
  instruct model pulled, for `ctrl+o`.

## Install

```
go install github.com/atyrode/code@latest
```

Release binaries and a Nix flake (with omp pinned in, so `nix run` just works)
are tracked in the issues.

## Configuration

Everything is an environment variable with a sane fallback:

| Variable | Purpose |
|---|---|
| `CODE_GENERATED` | path to the generated facet catalog (routing blocks per dial combo) |
| `CODE_USAGE` | command printing `omp usage --json` output for the usage panel |
| `CODE_SELECTION_STATE` | file persisting your dial choices (empty = no persistence) |
| `CODE_AUTH_VAULTS` / `CODE_AUTH_VAULTS_FILE` | vault manifest (JSON inline / path) |
| `CODE_AUTH_STATE` | persisted vault selection state |
| `CODE_OMP` | the omp binary for trusted launches (default: `omp-managed`, then `omp`) |
| `CODE_OMP_RAW` | plain omp, used for per-vault login handoff |
| `CODE_OMP_UNTRUSTED` | sandboxed omp for the `u` key (default: `ompu` if present) |
| `CODE_EVAL_MODEL` | ollama model tag for `ctrl+o` (default `qwen2.5:3b`) |
| `CODE_OLLAMA_ENDPOINT` | non-default ollama endpoint |
| `CODE_FACET_GLYPHS` | override the Nerd Font facet glyphs |

## Keys

`↑↓` facet · `←→` value · `d` reset to defaults · `ctrl+o` suggest ·
`a` cycle vault · `v` vault manager · `enter` launch generated ·
`m` managed default · `u` untrusted sandbox · `q` quit

## Caveats (current state)

- **The catalog is not yet self-generating.** The facet grid maps to
  pre-generated routing blocks; today that file is produced by a generator
  living in [atyrode/dotfiles](https://github.com/atyrode/dotfiles) from a
  pinned model list. Porting it here as `code generate` (reading your own
  `omp models --json`) is the top open issue — until then, `CODE_GENERATED`
  is on you.
- omp moves fast and its `omp models --json` / `omp usage --json` schemas carry
  no stability guarantee; the usage panel and generator are the coupling
  surface. Tested against the omp version current at each release.
- Some quota heuristics (bucket names, model-family colouring) reflect the
  author's provider mix. They fail soft.

Built on [cli-kit](https://github.com/atyrode/cli-kit) — the shared palette,
layout primitives, and the PromptBox behind `ctrl+o`.

## License

[MIT](./LICENSE) — extracted from
[atyrode/dotfiles](https://github.com/atyrode/dotfiles) (`pkgs/code-tui`).
