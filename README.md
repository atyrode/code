# Code — `atyrode.code`

**A Manifold-native coding-agent plugin, controlled through the web GUI.**

Code provides the coding-domain decisions around
[oh-my-pi (OMP)](https://github.com/can1357/oh-my-pi): model capability
ladders, provider-pool routing, thinking and review settings, routing previews,
and quota-aware cost and speed estimates. It is a plugin **inside
[Manifold](https://github.com/atyrode/manifold)**, not a separately configured
product alongside it.

> **Architecture direction, not a completed migration.** The standalone Code
> CLI/TUI is **deprecated**. The source baseline at `main@288190f` still
> contains that implementation and bootstrap plugins. The candidate
> headless/React/native-job work in [draft PR #148](https://github.com/atyrode/code/pull/148)
> needs rework: its standalone coexistence assumptions are rejected. Neither
> that draft nor this documentation establishes a supported, preview-ready,
> or live-accepted Manifold-native product.

The operator-ratified correction is tracked in
[#149](https://github.com/atyrode/code/issues/149). Start with the
[owning architecture](docs/manifold-transition.md), not the old terminal
launcher or its installation instructions.

## Product and platform boundaries

| Code owns | Manifold owns |
| --- | --- |
| Coding-domain configuration and validation; model ladders and routing policy; previews, estimates and coding workflows; plugin GUI and domain actions | Fleet and placement; permissions and scoped service access; multiplayer/shared state and persistence; resource lifecycle; execution and scheduling; traces |

There is **one Manifold-owned source of Code state**. Code must not keep a
second authoritative preference, account-selection, session or worktree store.
A missing generic platform capability belongs in Manifold; Code must not
emulate it with a private broker, registry, scheduler or transport.

Legacy or external services can be governed as native Manifold resources.
Their existence does not justify retaining the standalone Code architecture.
Access must use native, scoped service contracts rather than requiring the
operator's shell environment or a personal wrapper.

## GUI to OMP runtime

The target flow is:

1. Configure a coding task in Code's Manifold web GUI and inspect its routing
   and resource requirements.
2. Submit a domain action through Manifold's permission and resource model.
3. Have Manifold resolve scoped service access, place and execute the work,
   and own its lifecycle, persistent state and traces.
4. Use OMP for agent execution. An OMP terminal is an **execution surface
   only**, not the control plane or a hidden Code configuration UI.

Internal worker executables may implement domain work behind these native
contracts. They are not a second Code product to install or configure. OMP's
agent behavior, including model retries and fallback, should be used rather
than reimplemented; Manifold remains responsible for platform execution and
resource governance.

There is no target requirement for CLI/TUI parity, `CODE_*` compatibility,
standalone installation, a dotfiles wrapper, dual preference stores or a
permanent CLI recovery path. A future CLI, if needed, would be designed as a
Manifold client rather than preserve the deprecated launcher.

## Development entry points

- [Architecture and decisions](docs/manifold-transition.md) define the target
  contracts and platform prerequisites. Its
  [section 6](docs/manifold-transition.md#6-transition-steps) is the **sole
  transition ledger**.
- [Plugin development](plugins/README.md) describes the plugin tree, SDK pin
  and local development mechanics. Existing bootstrap code is an implementation
  reference, not proof of the target UX or architecture.
- [Status and caveats](docs/status.md) separates source evidence, draft work
  and operational acceptance, and records domain/runtime constraints.
- [Deprecated configuration reference](docs/configuration.md) explains legacy
  catalog and launcher mechanics when reading or extracting existing code. It
  is not Manifold onboarding or a required setup path.

Develop against explicitly identified Code and Manifold revisions. Promotion
must explicitly select exact revisions; building, packaging or checking a
plugin does not authorize installing it into a live environment. This work
does not authorize deployment, releases, credential relocation, broker
retirement or destructive state changes.

[MIT](LICENSE) — originally extracted from
[atyrode/dotfiles](https://github.com/atyrode/dotfiles).