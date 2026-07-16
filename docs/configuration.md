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
| `a` / `v` | cycle / manage auth vaults (if configured) |
| `p` / `f` / `s` | toggle routing panel / fallback chains / usage panel |
| `q` | quit |

## Environment variables

| Variable | Purpose | Without it |
|---|---|---|
| `CODE_GENERATED` | path to the generated facet catalog (the routing blocks behind the dials) | routing preview is empty — see [status](./status.md) |
| `CODE_USAGE` | command printing `omp usage --json` for the usage panel | panel hidden |
| `CODE_SELECTION_STATE` | file persisting your dial choices | choices reset each run |
| `CODE_OMP` | omp binary for trusted launches | `omp-managed`, then `omp` on PATH |
| `CODE_OMP_RAW` | plain omp, used for per-vault login handoff | `omp` on PATH |
| `CODE_OMP_UNTRUSTED` | sandboxed omp for the `u` key | `ompu` on PATH, else key hidden |
| `CODE_AUTH_VAULTS` / `CODE_AUTH_VAULTS_FILE` | vault manifest (inline JSON / path) | single default identity, vault UI hidden |
| `CODE_AUTH_STATE` | persisted vault selection | vault choice resets each run |
| `CODE_EVAL_MODEL` | ollama model tag for `ctrl+o` | `qwen2.5:3b` |
| `CODE_OLLAMA_ENDPOINT` | non-default ollama endpoint | `http://127.0.0.1:11434` |
| `CODE_FACET_GLYPHS` | override the Nerd Font dial glyphs | built-in glyphs |

## The `ctrl+o` classifier

Any ollama daemon on loopback works:

```
ollama pull qwen2.5:3b
```

The model is loaded into memory only when you choose (`ctrl+l` inside the
box toggles residency); a one-off suggestion never leaves weights resident.
Small instruct models around 3B parameters work best — smaller ones rate
every task the same.
