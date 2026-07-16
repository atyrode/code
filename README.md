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
the whole point is deciding, per task, how to blend the two pools and which
quota to spend. With a single provider you can still launch, but the dials
lose most of their meaning.

Too lazy to dial? Press `ctrl+o` and describe the task: a small local model
rates its difficulty and sets the dials for you. (Optional — needs
[ollama](https://ollama.com); everything else works without it.)

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
launches it, it doesn't replace it. (Either way, omp still needs your
provider logins: `omp login`.)

Then just run `code`. The first run notices there's no routing catalog yet
and walks you through building one from your omp's model list — it shows you
which model it picked for each rung, you sanity-check, press enter, done.

The same machinery is scriptable as `code generate init` (scaffold the models
file) and `code generate` (re-render the catalog after you edit it).

## More

- [Configuration](docs/configuration.md) — every key and environment variable
- [Status & caveats](docs/status.md) — what works out of the box, what is
  still shaped by the author's setup, and where this is going

[MIT](./LICENSE) — extracted from
[atyrode/dotfiles](https://github.com/atyrode/dotfiles).
