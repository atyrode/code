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
| `CODE_USAGE` | command printing `omp usage --json` for the usage panel | panel hidden |
| `CODE_SELECTION_STATE` | file persisting your dial choices | choices reset each run |
| `CODE_OMP` | omp binary for trusted launches (`m` and `enter`) | `omp-managed`, then `omp` on PATH |
| `CODE_OMP_UNTRUSTED` | sandboxed omp for the `u` key | `ompu` on PATH, else the key is hidden and inert |
| `CODE_EVAL_MODEL` | ollama model tag for `ctrl+o` | `qwen2.5:3b` |
| `CODE_OLLAMA_ENDPOINT` | non-default ollama endpoint | `http://127.0.0.1:11434` |
| `CODE_FACET_GLYPHS` | override the Nerd Font dial glyphs | built-in glyphs |

Provider authentication is owned by OMP, not `code`. Authenticate with
`omp auth-broker login` before launching `code`.

## The `ctrl+o` classifier

Any ollama daemon on loopback works:

```
ollama pull qwen2.5:3b
```

The model is loaded into memory only when you choose (`ctrl+l` inside the
box toggles residency); a one-off suggestion never leaves weights resident.
Small instruct models around 3B parameters work best — smaller ones rate
every task the same.
