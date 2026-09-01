# Configuration

## models.yml columns

| column | meaning |
| --- | --- |
| `pool` | `O` (OpenAI/Codex), `A` (Anthropic), or `D` (DeepSeek). `O` and `A` must fill tiers 1..3; `D` is optional — one verified model is enough, missing tiers borrow the nearest rung |
| `tier` | position on the pool's capability ladder. `1` cheap, `2` regular, `3` smart, and an optional `4` — a fourth rung the model dial's `elite` notch reaches. Ladder depth is per pool: Anthropic ladders to 4 today, Codex to 3, and a provider shipping a fourth model needs no code change to light its own `elite` up. `0` is off the ladder entirely: the fast idle-bucket model the `spark` toggle drains |
| `bucket` | the quota window the model draws — drives the usage meter |
| `image` | `false` marks a text-only model, which the vision role then avoids |

The `elite` notch is offered only on lanes whose **lead** pool has a tier-4
rung. That is not the same as "any pool in the lane" — the deliberative bump
already gives plan/slow/designer/reviewer the top rung at `smart`, so on a lane
led by a three-rung pool `elite` would render a block identical to `smart`.

## Glyphs and fonts

The facet dials are labelled with Nerd Font Private Use Area codepoints, so a
terminal without a patched font renders them as tofu boxes. `code` cannot fix
that for you: font selection belongs to the terminal emulator, and a
Nix/goreleaser package of a TUI binary has no way to reach into it. Installing
the font is the operator's business — [dotfiles](https://github.com/atyrode/dotfiles)
does it via `nerd-fonts.symbols-only` in the `agent-tools` profile.

What `code` does provide is a fallback, so an unpatched terminal is legible
rather than broken:

| `CODE_SYMBOLS` | glyphs |
| --- | --- |
| unset, or `nerd` | Nerd Font icons (the default — every existing install renders these) |
| `unicode` | plain BMP symbols (`⇄ ⚙ ✦ ◎`) that any modern monospace font carries |
| `ascii` | one-letter tags, for pipes, CI logs and anything hostile to non-ASCII |

`CODE_FACET_GLYPHS` ("`model=*,lane=>`") overrides individual keys on top of
whichever preset resolved.

omp has its own `symbolPreset` setting with the same three values, and `code`
deliberately does **not** read it: omp reports `unicode` on a machine where
nobody ever set it, so the value cannot distinguish a deliberate choice from
omp's default — and taking it at face value silently restyled a machine whose
operator had asked for nothing. Set `CODE_SYMBOLS` where you set the font.

## Keys worth knowing

| key | effect |
| --- | --- |
| `f` | primary lead ⇄ full fallback chains |
| `n` | short model keys ⇄ full catalog model ids — a sanity check on what the current dials actually route to |
| `i` | short ⇄ full account ids in the Usage panel |
| `d` | reset the dials to defaults |
| `?` | the rest of the key map |

`n` is a view preference: it defaults to off and is never persisted into the
selection state, because it changes nothing about routing.
