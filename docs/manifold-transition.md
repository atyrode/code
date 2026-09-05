# Code as a manifold plugin: the transition

Status: operator direction, recorded 2026-09-05. Every manifold fact below was
read at manifold `main` @ `8466628` (v0.6.2, 2026-09-02; `dev` is retired,
atyrode/manifold#174); every code fact at `atyrode/code` `main` @ `76b1d8f`;
every dotfiles fact at `atyrode/nix-dotfiles` `main` @ `bbeb8e3`; Babel's
record at `atyrode/babel` `main` @ `93eb714`. Tags are `exists` (in code,
cited), `declared` (named in a ratified manifold document, not implemented),
`absent` (searched for, not found; the search is named where it is claimed).

Babel went first: `~/babel/docs/manifold-transition.md` is the model, and its
manifold prerequisites are cited by number rather than restated. Babel's
citations were pinned to the retired `dev`; every line below was re-read at
`main`, and several moved.

---

## 1. Status and direction

**The invariant.** Code's final form is a manifold plugin: a persistent, small
launcher UI that spawns omp-ready terminals on enrolled machines. The dials,
the routing preview, the usage panel and the account manager become
plugin-rendered UI inside manifold's workspace; the launch becomes a manifold
terminal on a machine the operator picks; the machines are manifold's
enrolled spokes. Code adapts to manifold. What manifold cannot offer is filed
as a manifold issue so manifold can evolve, never worked around in code with a
second mechanism.

**What "stepwise" permits.** The Bubble Tea program (`main.go:58`, `runInteractive`
at `main.go:302`) stays until the plugin is proven end to end, so an operator
never loses a working launcher. It permits nothing else: from this date nothing
new is built TUI-bound that is not also reachable headless. A capability that
would land in `update.go` lands first in the headless verb (§5, D2) or in a
`code.*` door (§5, D3); a rendering that would land in `view.go` waits for its
plugin surface. The final step (§6, step 6) retires the TUI.

**The dual purpose.** Code is the second third-party plugin after Babel, and
the attempt is an instrument: it discovers what manifold's plugin story lacks
for an out-of-tree author with a different shape of need — Babel needs a
process without a PTY, code a PTY with a program in it. Babel's prerequisites
(atyrode/manifold#151 to #160) are reused by number; what code finds beyond
them is drafted in §8.

**Settled before this document** (operator, via the orchestrator): manifest
ids live in the `code.<x>` namespace; secrets never enter manifold; the
Babel-worker half of code is out of the launcher's scope; launch authority
stays on the spoke. Decisions D1 to D6 are in §5 and are settled.

---

## 2. What manifold is, for a code reader

Babel's record §2 (`~/babel/docs/manifold-transition.md:54-275`) explains the
axioms, the plane rule, the floor, what a plugin structurally is, loading,
identity, machines, persistence and release discipline. None of it changed in
substance at `main@8466628`: `CHANGELOG.md:3-14` shows `[Unreleased]` empty
and v0.6.2 carrying a macOS agent binary (#176, #181), CI on every pull
request (#174, #179; Babel's "no CI on PRs into dev" gotcha is obsolete) and
the hub-then-agents pin handoff (#175, #180). What follows is what a launcher
author needs and a Babel reader would not have looked at.

### 2.1 A terminal, on the wire

- **`core.terminals.open` authorizes; it does not create.** The action's own
  comment: "the PTY is born on the session channel ... `core.terminals.open`
  answers 'may a terminal be created here, now, by you', and `terminal_open`
  on the channel is the gesture that asks it and then moves the bytes"
  (exists, `packages/plugins/terminals/src/index.ts:87-100`; the handler
  returns `{}` after the containment check,
  `packages/plugins/terminals/src/server.ts:56-68`). It needs
  `terminals:spawn` and is container-scoped (`:99-100`).
- **Creation is a session-socket frame.** `terminal_open {elementId, cols,
  rows, cwd?, machineId?, placement?: "tile"}` (exists,
  `packages/protocol/src/session.ts:192-210`), answered by `terminal_opened
  {elementId, terminal, ref?}` (`:401-412`). The SDK wraps it as
  `SessionClient.openTerminal({... timeoutMs?})`, 15 s default
  (`packages/sdk/src/session-client.ts:1136-1184`). There is no HTTP
  equivalent: a bearer token and `POST /api/actions/:name` cannot create a
  terminal.
- **`create` carries no command.** The server-to-agent `create` frame is
  `{terminalId, cols, rows, cwd?, env}` (exists,
  `packages/protocol/src/machine.ts:76-86`); the agent always spawns
  `resolveShellCommand()`: `$SHELL`, else `bash`, else `sh` on PATH
  (`packages/agent/src/terminal.ts:114-129`). The only way to run a program
  is to type it: `terminal_input {terminalId, data: base64}`
  (`packages/protocol/src/session.ts:219-223`;
  `SessionClient.sendTerminalInput`, `session-client.ts:1211-1214`), which
  the plane rule classes as channel traffic (`AXIOMS.md:133-135`) whose
  lifecycle, not bytes, is traced (`AXIOMS.md:105-106`).
- **The PTY's env is fixed to four keys.** The client frame has no `env`; the
  broker injects exactly `MANIFOLD_URL`, `MANIFOLD_CONTAINER`,
  `MANIFOLD_ELEMENT` (canvas openers only) and a terminal-scoped
  `MANIFOLD_TOKEN` (exists, `packages/server/src/terminal-broker.ts:529-544`;
  documented at `machine.ts:81-85`). The agent strips every `MANIFOLD_*` from
  its own environment before adding those back
  (`packages/agent/src/terminal.ts:131-146`). Nothing else rides env.
- **The opener holds the controller lease** (`terminal-broker.ts:612`);
  `core.terminals.take` moves it (`terminals/src/index.ts:140-141`). A
  terminal is born with a home composition before its first byte
  (`docs/CONTRACTS.md:385,402-404,1415-1418`).

### 2.2 Where a terminal can be placed

- **Two trees, one wire shape, disjoint leaves.** `TileRefSchema` is one union
  of `terminal | container | text | panel | spacer`
  (`packages/protocol/src/layout.ts:85-108`) used by both a container's tile
  tree and the workspace's own layout. `core.space.setLayout` refuses every
  workspace leaf but `panel` and `spacer`: `workspace leaves hold panels, not
  "${node.ref.kind}"` (exists, `packages/plugins/shell/src/server.ts:103-111`).
  A terminal cannot sit beside a plugin panel in the workspace tree.
- **`contributes.panels` and `seats`** put a plugin's own leaf in the
  workspace tree (`docs/PLUGINS.md:678-687`; at most 8 panels,
  `packages/protocol/src/plugin.ts:317,324`). `HostServices.tileGeometry` is
  read-only (`packages/plugin/src/host.ts:398-399`).
- **A terminal lives in a composition**, reached by `navigate(uri)`
  (`host.ts:374`), moved by `core.space.place`
  (`packages/plugins/shell/src/server.ts:135-137`; `PlaceRequestSchema`,
  `packages/protocol/src/placement.ts:685`), and born there with
  `placement: "tile"`. `HostServices.authoring.createTerminal(machine?)` is
  offered only by the mounted container view (`host.ts:154-156,397`;
  `packages/web/src/workspace.tsx:734-738`); a sidebar panel has no authoring
  handle. A new composition is `core.index.createContainer {name,
  discipline?}` (`packages/plugins/index/src/index.ts:159-163`;
  `packages/protocol/src/http.ts:28-31`).
- **Disciplines are open.** `ContainerDisciplineSchema` is a bounded string,
  not an enum (`layout.ts:29-34,66-72`); a plugin declares one in
  `contributes.disciplines` (at most 4, `plugin.ts:362`;
  `DisciplineDefSchema`, `packages/protocol/src/placement.ts:390-397`) and
  registers a `ContainerRendererProps` renderer
  (`packages/plugin/src/projection.ts:160-183`). But the placement executor
  still decides tile-tree-ness by the literal `"composition"` in twelve sites
  (`packages/server/src/placement.ts:339,513,905,1047,1588,1681` gates;
  `:399,611,959,1321,1350,1663` mints) — declared gap atyrode/manifold#134.
  `docs/PLUGINS.md` never documents `contributes.disciplines` (absent: the
  word occurs at `:73,153,246,653,725,1007,1100,1234`, none of them the
  contribution kind).

### 2.3 What a plugin's browser half is handed

- `HostServices` (`packages/plugin/src/host.ts:351-406`): `client`
  (`SessionHandle`), `token` (`:366`), `containerId`, `navigate`, `viewport`,
  `authoring`, `tileGeometry`, `assembly`, `topics`. `SessionHandle`
  (`:52-115`) offers `action`, `place`, `selfCaps`, `machines()` (`:59`),
  `index`, `terminalsByContainer`, `resolve`, `allTerminals`, the index
  writers, `removeContainerTile`, `subscribe` (`:110`) and `status`. **It has
  no `openTerminal` and no `sendTerminalInput`**; "whatever is not on this
  interface is not reachable from plugin code" (`:49`).
- The shipped container renderers get a terminal anyway by minting their own
  `new SessionClient({url, containerId, token: host.token})`
  (`packages/plugins/compositions/src/composition-view.tsx:180-182,512-544`;
  `projection.ts:167-168`), and the terminal viewer types through that client
  (`packages/plugins/terminals/src/terminal-view.tsx:41,432`). ADR 0016
  removes exactly this: an isolated plugin gets "no `HostServices` object
  with a live `SessionHandle` in it" and `HostServices.token` "is not given"
  (`docs/decisions/0016-plugin-isolation.md:221-231`).
- `HostServices.action(name, args)` dispatches any full action name
  (`host.ts:53-54`); a server-half handler has no `ctx.dispatch` (absent from
  `ActionCtx`, `packages/server/src/plugin-host.ts:249-350`), so a gesture
  needing several doors is several round trips with no transaction.
- Push reaches a plugin through `client.subscribe` or `usePolledResource`,
  whose 2 s fallback runs only while there is no session channel
  (`packages/plugin/src/polled-resource.ts:64-77`; `core.machines.list` is a
  shared feed, `:61`). Direct `fetch` is disallowed (`docs/PLUGINS.md:820-821`).

### 2.4 Loading, still static

`SERVER_PLUGIN_DEFS` and `WEB_PLUGIN_DEFS` are static array literals in "the
only server file allowed to import `@manifold-plugin/*`" and "the ONE file in
`packages/web/src` allowed to name `@manifold-plugin/*`"
(`packages/server/src/assembly.ts:61-63,76`;
`packages/web/src/assembly.ts:119-122,174`); ADR 0020 names the consequence,
"There is no host-composition mechanism"
(`docs/decisions/0020-desktop-shell.md:43-54`). ADR 0016 is ratified and
unbuilt (`docs/decisions/0016-plugin-isolation.md:4-20`); `entry` is
"reserved, dynamic wave" (`packages/protocol/src/plugin.ts:554-555`);
`@manifold/plugin`, `@manifold/sdk` and `@manifold/protocol` are `"private":
true` workspace packages (`packages/plugin/package.json:2-3`,
`packages/sdk/package.json:2-3`, `packages/protocol/package.json:2-3`).
Nothing landed toward atyrode/manifold#151 or #152 since Babel's study.

### 2.5 Ceilings, current values

| Ceiling | Value | Citation |
| --- | --- | --- |
| `PROTOCOL_VERSION` | 21 | `packages/protocol/src/version.ts:2` |
| `MACHINE_PROTOCOL_COMPAT_VERSIONS` | {16..21} | `version.ts:216-218` |
| `CAPS` | 9 members, closed | `packages/protocol/src/capabilities.ts:11-22` |
| manifest `capabilities` | at most 16 | `packages/protocol/src/plugin.ts:520` |
| `SETTING_KINDS` | `["boolean"]`, at most 8 settings | `plugin.ts:104,402` |
| `MAX_STORAGE_VALUE_BYTES` | 64 KiB; keys ≤128 chars | `packages/plugin/src/storage.ts:58,74` |
| `MAX_HTTP_BODY_BYTES` | 1,048,576 | `packages/server/src/http.ts:36` |
| `MAX_SESSION_FRAME_BYTES` | 1,048,576 | `packages/protocol/src/elements.ts:8` |
| `MAX_SESSION_BASE64_CHARS` | 700,000 | `elements.ts:25` |
| `LIFECYCLE_TIMEOUT_MS` | 2,000 | `packages/plugin/src/lifecycle.ts:21` |
| event kind | ≤48 chars, snake_case | `packages/protocol/src/events.ts:40,59-60` |
| event payload | flat, bounded | `events.ts:73` |
| subscriptions | 64 per frame, 256 per connection | `events.ts:82,91` |
| session channels | 64 per connection | `packages/protocol/src/session.ts:73` |
| node kinds | 7, no `machine` | `packages/protocol/src/uri.ts:33-45` |
| `SECRET_FIELD` | `/(token\|key\|authorization\|secret)/i` | `packages/server/src/log.ts:36` |

---

## 3. Surface inventory of code

### 3.1 Subsystem map

Non-test Go is 864,806 bytes across 39 files (`wc -c *.go`, tests excluded).
The Babel-worker half — `babelwire.go`, `babelworker.go`, `babelprofile.go`,
`babelconfigure.go`, `ompinvestigator.go`, `omprpc.go`, `ompprocess_*.go`,
`sandbox*.go`, `locallane.go` — is 446,452 bytes, 51.6 % of it, and is out of
this record's scope (D6). The launcher half:

| File | Responsibility |
| --- | --- |
| `main.go` | argv dispatch (`:38-56`), the interactive app, the post-loop launch switch (`:63-104`), glyph tables (`:113-134`) |
| `launch.go` | argv assembly (`:11-44`), binary resolution (`:46-57`), `runChild` (`:63-75`), overlay temp file (`:156-163`) |
| `model.go` | the `model` struct (`:34-114`), the 1 s tick and 5 min usage cadence (`:118-123`) |
| `update.go` | every key (`:135-289`), Enter (`:252-288`) |
| `view.go`, `render.go`, `layout.go` | rendering and responsive size classes |
| `keys.go` | `keyMap` (`:6-8,25-43`), `defaultSel` (`:47`) |
| `facets.go`, `facts.go` | the `facet` type (`facets.go:9`), `loadBlocks` catalog parser (`facts.go:11`) |
| `routing.go` | `currentRows` (`:58-60`), `comboID` (`:385`), `genConfigYAML` (`:771-862`), `sessionFlags` (`:864-874`) |
| `generate.go`, `generate_init.go` | `code generate [init]`; `omp models --json` probe (`generate_init.go:41-43,878-918`) |
| `usage.go` | broker usage fetch (`:134`), usage cache (`:440,498`), the usage panel |
| `manager.go` | account manager UI; OAuth login via `tea.ExecProcess` (`:309-317`) |
| `vault.go` | accounts, broker resolution (`:93-98`), account pool file (`:788-789`), auth env (`:866-893`), DeepSeek balance (`:938-956`) |
| `providers.go` | provider, pool, lane and tier registry |
| `session.go` | flock-based session registry (`:85-102,156-167`), reap (`:363-389`), `withSession` (`:561`) |
| `worktree.go` | `code/<adj>-<color>-<animal>` worktrees under code's own state root (`:103,261-300`) |
| `selection_state.go` | `CODE_SELECTION_STATE` load/save and the ceremony handoff mirror (`:24-29,46-49,73-76,226-229`) |
| `onboarding.go` | first-run scaffold, `obScan` (`:71-92`) |
| `suggest.go`, `runtime.go` | ctrl+o prompt-to-profile over a loopback Ollama (`suggest.go:59-64,88-94`); delegated runtime broker (`runtime.go:36,137-138`) |
| `wheel.go`, `colorize.go`, `theme.go` | trackpad wheel gesture filter (`wheel.go:17-18,51`); model colouring; palette |

### 3.2 CLI verbs

| Verb | Mode | Citation |
| --- | --- | --- |
| `code` / `code <prompt or omp flags>` | interactive: dials, then launch | `main.go:58-104` |
| `code generate` | headless: `models.yml` to `generated.plain` | `main.go:40-41` |
| `code generate init` | headless, minutes: probes every model through `omp models --json` and `omp bench` | `generate_init.go:878-918,814-815` |
| `code session` / `code ls` / `code session reap` | headless: registry, whole-tree reap | `main.go:42-43,54-55`; `session.go:402-454` |
| `code worktree` / `code wt [remove\|prune]` | headless | `main.go:44-45`; `worktree.go:439-570` |
| `code babel [...]` / `--configure --result-file P` | Babel wire protocol on stdio / interactive ceremony, refuses without a TTY | `main.go:46-47`; `babelconfigure.go:3,58-63,113-117` |
| hidden `__sandbox` | in-guest helper | `main.go:48-53` |

### 3.3 TUI surfaces and keys

- **Generator dials** — `lane`, `model`, `thinking`, `advisor`, `spark`, and
  the `more` fold (`fast`, `prewalk`, `planyolo`), plus `runtime` and (ceremony
  only) `local`; defaults in `keys.go:47-50`. Mutates `m.sel`, persisted on
  every change (`selection_state.go:226-229`).
- **Routing preview** — `f` primary ⇄ full chains (`update.go:200`), `n` short
  ⇄ full ids (`:173`), `p` show/hide.
- **Usage panel** — `s` show/hide (`:152`), `r` refresh (`:203`), `i` account
  ids (`:170`); auto-refresh every 5 min (`model.go:118`).
- **Account manager** (`v`, `update.go:207`) — toggle, presets, `a` OAuth login
  (`manager.go:475`; `CODE_AUTH_LOGIN_VIA`, `:314`), `x` clear blocks
  (`:494-501`).
- **Launch keys** — `enter` generated profile (`update.go:252-288`), `m`
  managed (`:241-251`), `u` untrusted (`:225-236`), `w` worktree mode
  (`:219-224`).
- **Help** `?` (`:179`), **reset** `d` (`:182`), **quit** `q`/`esc`/`ctrl+c`
  (`:136-137`), **ctrl+o** suggest box, mouse wheel through `wheelInputFilter`
  (`main.go:302-305`; `wheel.go:51`).

### 3.4 The launch path

1. **Enter** (`update.go:252-288`): a local-lane pick in a ceremony sets
   `localConfirmed` and quits (`:257-266`); a runtime target sets
   `launchRuntime` (`:268-271`); `noProviders` is a no-op (`:272-274`); a
   combo the catalog lacks is a no-op (`:284-286`); else `m.genConfig =
   m.genConfigYAML()` and `tea.Quit` (`:287-288`).
2. **Post-loop** (`main.go:63-104`): worktree mode creates a
   `code/<name>` worktree (`:65-75`; `worktree.go:261-300`, branch at `:290`),
   `launchDir` becomes its child dir (`:76-79`); the launch kind dispatches
   inside `withSession` (`:82-104`; `session.go:561`), which holds an
   exclusive flock for the child's whole life (`session.go:85-102`). The
   worktree is released after the child exits, removed only if pristine
   (`main.go:105-106`; `worktree.go:303,315`).
3. **Overlay** (`routing.go:771-862`): `modelRoles` and `retry.fallbackChains`
   from `currentRows()` (`:812-813`), `task.agentAdvisor` gated on omp ≥ 17.3
   (`:819`), `prewalk` (`:827-841`), `defaultThinkingLevel` (`:843`), `tier`
   per provider when the fast dial is on (`:855`); written to a
   `code-gen-*.yml` temp file, removed on exit (`launch.go:156-163`).
4. **argv** (`launch.go:36-44`): `[omp, --config, cfg, ...sessionFlags,
   ...stripProfileArgs(forwarded), prompt?]`; `--plan-yolo` is the only
   argv-borne dial (`routing.go:864-874`; `stripProfileArgs`, `vault.go:909`).
5. **env**: `withAuthEnv` replaces the four `OMP_AUTH_BROKER_*` keys and
   points omp at a per-launch account-pool file (`vault.go:866-871,881-889`);
   the untrusted launcher gets `withoutAuthEnv` (`:873-879,891-893`).
6. **Binary**: `resolveLaunchPath("CODE_OMP", ["omp"])`, explicit env first,
   then PATH (`launch.go:46-57`).
7. **The child** (`launch.go:63-75`): `exec.Command(...).Run()` with
   `Stdin/Stdout/Stderr = os.Std*`; code blocks as the live parent, which is
   what its liveness is (`session.go:12-15`), and propagates the exit status.
8. **First prompt**: `m.firstPrompt` (argv passthrough or the ctrl+o box) is
   the last argv token (`launch.go:11-16,40-43`; `model.go:109`).

### 3.5 Persistent state

| Path or variable | Shape | Citation |
| --- | --- | --- |
| `CODE_SELECTION_STATE` (`off` disables); default mirror for the ceremony | flat map of ~10 facet keys | `selection_state.go:24-29,46-49,73-76` |
| `CODE_SESSION_STATE` (`off` disables), `$XDG_STATE_HOME/code/sessions` | one flocked record per live session: PID, binary, profile, pool, worktree | `session.go:32-33,55-71,608-609` |
| `CODE_WORKTREE_DIR`, `CODE_WORKTREE_STATE` | git worktrees and one JSON record each | `worktree.go:72,103,207-208,637-639` |
| `CODE_AUTH_ACCOUNT_STATE` | manual-disabled set and named presets, non-secret | `vault.go:461,615` |
| `CODE_USAGE_CACHE` | last availability snapshot; balance value, never a key | `usage.go:440,498` |
| `CODE_GENERATED` (`models.yml`, `generated.plain`) | the catalog; `testdata/two-pool-golden.plain` is 211,213 bytes (206 KiB) for two pools | `generate.go:1033-1034`; `facts.go:11` |
| temp `code-auth-account-pool-*`, `code-gen-*.yml` | per-launch pool file and overlay | `vault.go:788-789`; `launch.go:157` |

### 3.6 External services

- **Auth broker** (`OMP_AUTH_BROKER_URL/TOKEN`, `vault.go:93-98`): identities,
  blocks, quota windows (`usage.go:134`); block clearing (`vault.go:281`).
  Loopback on dev-01, reached from other clan machines by SSH forward
  (`~/nix-dotfiles/docs/agent-tools.md:134-153`); never reachable from the hub.
- **omp**: the launched child, `omp --version` (`model.go:203`), `omp models
  --json` and `omp bench` (`generate_init.go:41-43`), `omp auth login` via
  `tea.ExecProcess` (`manager.go:309-317`).
- **DeepSeek balance**: direct HTTPS with an in-memory key (`vault.go:938-956`,
  `apiKey` deliberately unexported, `:22-34`).
- **Ollama** (`CODE_OLLAMA_ENDPOINT`, `suggest.go:88-94`; `locallane.go:57`).
- **Runtime broker** (`CODE_RUNTIME_BROKER`, `runtime.go:36,137-138`).
- **The dotfiles wrapper**: `code` on PATH is `codeLauncher`, which exports
  `CODE_GENERATED`, `CODE_OMP`, `CODE_OMP_UNTRUSTED`, the `OMP_AUTH_BROKER_*`
  trio read from `~/.omp/auth-broker.token`, `CODE_RUNTIME_BROKER`,
  `CODE_AUTH_ACCOUNT_STATE` and `CODE_SELECTION_STATE` on every invocation
  before `exec`ing the real binary
  (`~/nix-dotfiles/pkgs/omp-configured/default.nix:1495-1530,1602-1604`).

### 3.7 Fate

| Surface | Fate | Why |
| --- | --- | --- |
| Dials, routing preview, usage panel, account manager rendering | browser half | pure state and render at the model level |
| `genConfigYAML`, `sessionFlags`, `comboID`, catalog parsing | spoke, behind `code launch` | the overlay is a file path handed to omp (`launch.go:156-163`); the spoke owns the file and the binary |
| The launch itself (`runChild`) | spoke: `code launch` inside a manifold PTY | blocks as the live parent; needs the PTY (§3.4 step 7) |
| Session registry, worktrees | spoke, projected by `code publish` | flock liveness on one filesystem (`session.go:12-15`); reap signals local PIDs |
| Usage fetch, broker, DeepSeek, account pool | spoke, projected non-secret | the broker is loopback-only; keys never serialise (`vault.go:22-34`) |
| Account toggles and presets | browser half over `code.*` doors | non-secret (`vault.go:461-490`) |
| OAuth login `a`, `CODE_AUTH_LOGIN_VIA` | CLI-only | hands the terminal to omp (`manager.go:309-317`) |
| Onboarding review step | browser half; the probe is a spoke job | `obScan` shells to omp for minutes (`onboarding.go:71-92`) |
| `code generate [init]`, `code session`, `code wt`, `code babel*` | CLI-only | recovery, and D6 |
| Glyph tables, `CODE_SYMBOLS`, wheel filter | retired | terminal-font and mouse-protocol workarounds (`main.go:113-134`; `wheel.go:17-18`) |

**Four load-bearing terminal assumptions.** (1) `runChild` owns the
controlling terminal from before Bubble Tea mounts to after the child exits
(`launch.go:63-75`). (2) `requireOperatorTerminal` refuses the ceremony
without a TTY on both ends (`babelconfigure.go:113-117`). (3) `tea.NewProgram`
assumes an interactive terminal for the whole dial session (`main.go:302`).
(4) Onboarding probes omp synchronously inside the TUI, spinner-gated
(`onboarding.go:105-106`). D2 removes (1) from the plugin's path by keeping it
on the spoke; (2) is Babel's (§8.3); (3) and (4) go with the TUI.

---

## 4. Capability map

One row per code need. "Manifold offers" carries the tag and citation; the
last column names a settled decision (§5), an existing manifold issue, or a
draft title from §8 (`[class] Title`).

| Need | Manifold offers | Missing | What code changes | Decision or draft issue |
| --- | --- | --- | --- | --- |
| **N1** Identity | exists: one `Principal {kind: "human" \| "agent"}` (`packages/protocol/src/principal.ts:5-7`); agent tokens never expire (`docs/CONTRACTS.md:147-151`); a program in a PTY gets a terminal-scoped `MANIFOLD_TOKEN` (`terminal-broker.ts:542`). | Nothing. | `code publish` runs as an agent-kind principal per machine; the operator is the owner key or a human principal; `code launch` inside the PTY may read `MANIFOLD_TOKEN` to correlate its session record with the terminal. | D3; Babel #143 pattern. |
| **N2** Machines | exists: `core.machines.list` returns `{id, name, online}` (`packages/plugins/machines/src/index.ts:89-93`; `packages/protocol/src/http.ts:322-338`); `SessionHandle.machines()` (`host.ts:59`); `MACHINES_RESOURCE` feed (`polled-resource.ts:61`). absent: a `machine` node kind (`uri.ts:33-45`). | Per-machine grants; a declared "this machine has `omp` and `code`" fact. | The machine picker is the roster; a single-spoke fleet (`~/nix-dotfiles/fleet/manifold.json:9-11`) picks without asking. | atyrode/manifold#157; #153 (comment, §8.1). |
| **N3** A terminal on a machine with command, cwd, env | exists: `terminal_open {cwd?, machineId?, placement?}` (`session.ts:192-210`), `$SHELL` only (`agent/terminal.ts:114-129`), env fixed (`terminal-broker.ts:535-543`). absent: a command field on any frame. | `terminal_open` carrying argv. | Interim: open, wait for the shell, type `code launch --selection ...`. End state: the PTY execs it. | D2; `[prerequisite] Session-channel terminal_open should carry a command/argv, not force every PTY through a login shell`. |
| **N4** Placement beside the launcher | exists: `placement: "tile"` into a composition; `core.space.place`; `navigate`. absent: a terminal leaf in the workspace tree (`shell/src/server.ts:108-109`); a plugin pane inside a composition's tile tree. declared: #134 for third-party tile-tree disciplines. | A composition-shaped discipline hosting a plugin pane beside terminal tiles, without the twelve literals. | Interim: a `code.launcher` panel; the terminal lands in the composition in view or a code-created one, then `navigate`. End: `code.launchpad` discipline. | D4; atyrode/manifold#134; `[prerequisite] A discipline that hosts plugin UI beside a live terminal tile in one addressable view`. |
| **N5** Terminal creation from a plugin's browser half | exists, in-realm only: renderers mint a `SessionClient` from `host.token` (`composition-view.tsx:180-182`). absent from `SessionHandle` (`host.ts:52-115`); removed by isolation (`0016:221-231`). | `openTerminal` and `sendTerminalInput` on the plugin-facing handle, or an RPC equivalent. | The interim types keystrokes through whatever handle exists; the end state needs none. | `[prerequisite] SessionHandle has no plugin-facing terminal handle; shipped renderers escape it with a self-minted SessionClient using host.token, which isolated plugins will not have`. |
| **N6** Live projections (catalog, usage, version, sessions) | exists: `core.*` and `code.*` doors, `ctx.storage`, `ctx.emit` staged on `ok` (`plugin-host.ts:340-349,1207-1210`), `usePolledResource`. absent: a plugin-declarable continuous stream (atyrode/manifold#169). | Nothing for these cadences (5 min usage, per-launch sessions). | `code publish` posts through `code.*` doors, each emitting one event; the browser re-reads. | D3; #169 not on code's path. |
| **N7** Storage for a 206 KiB catalog | exists: `plugin_kv`, 64 KiB values (`storage.ts:74`); 1 MiB bodies (`http.ts:36`). absent: blobs (atyrode/manifold#159). | Nothing if the catalog is split. | One key per combo (`comboID`, `routing.go:385`) plus an index key; never one key for the file. | D3; `[improvement] MAX_STORAGE_VALUE_BYTES's 64 KiB ceiling has no stated rationale, and no blob class for catalog-sized plugin data` (references #159). |
| **N8** Settings (default lane, model, thinking) | exists: boolean, per principal, at most 8 (`plugin.ts:104,128-133,402`). | An enum kind and a workspace scope. | The selection state stays a `code.*` projection per principal; a default is a `code.*` door until #158. | atyrode/manifold#158. |
| **N9** Events | exists: declared kinds, flat payloads, no replay (`events.ts:40,73,82,91`). | Nothing. | `code.*` doors emit `catalog_published`, `usage_published`, `sessions_changed`, `launch_requested`. | Settled. |
| **N10** Loading out of tree | exists: static assembly only (§2.4). declared: ADR 0016 stage 1 and dynamic loading. | The loader; published or pinned SDK packages. | The package lives in `atyrode/code` under `plugin/`; ships as a hashed artifact from code's release. | D1; atyrode/manifold#151, #152, #154. |
| **N11** Binary dependency on `omp` and `code` on the spoke | absent: a manifest field for an external binary (atyrode/manifold#153). exists: the dotfiles wrapper puts `code` on PATH with its whole environment (`default.nix:1495-1530`). | The declaration; a roster signal when the binary is missing. | The plugin declares `omp` and `code`; until then a missing binary is a shell error in the terminal. | D2; #153 (comment). |
| **N12** Secrets | absent: no vault, no env injection; `SECRET_FIELD` redacts by name (`log.ts:36`). | Nothing requested. | Broker token, DeepSeek key and account pool stay on the machine; no `code.*` door accepts one. | D5. |
| **N13** Sessions and worktrees liveness | exists: `terminal_exited`, `core.terminals.list` (`terminals/src/index.ts:51,159-162`). absent: a process registry. | Nothing: the flock is the truth and the spoke reads it. | `code publish` projects the registry; `code session reap` stays CLI-only; a manifold terminal exit is a second signal, not a replacement. | D3; D6. |
| **N14** Onboarding's long probe | absent: any supervised job primitive (atyrode/manifold#156); lifecycle hooks are 2 s (`lifecycle.ts:21`). | A job with progress. | `code generate init` stays CLI-only; its review step is a surface later; `code publish` reports the result. | D6; #156 not on code's path (D2 wants a PTY). |

---

## 5. Decisions (settled 2026-09-05)

### D1 Loading: out of tree, in atyrode/code, Babel's D1

The plugin package lives in `atyrode/code` and is loaded out of tree. No
vendoring into `packages/plugins`, for the three reasons Babel's record gives
(`~/babel/docs/manifold-transition.md:313-324`): it would push the marketplace
wave back, mint extraction debt, and contradict manifold building what its
plugins need. A throwaway in-tree spike under `docs/spikes/` is permitted
purely as sizing evidence for atyrode/manifold#160, in the format of
`docs/spikes/s126-dockview/README.md:1-7` ("DISPOSABLE ... throwaway evidence,
not application code"), and is never merged as a plugin.

Consequences:

- Nothing of code renders inside manifold before out-of-tree loading exists.
  Step 1 is host-independent work on both sides.
- Under ADR 0016 the browser half paints through the closed component
  vocabulary and is not handed `host.token` (`0016:221-231`); the interim
  keystroke path (D2) therefore depends on a plugin-facing terminal handle
  (N5) or lives only as long as in-realm trust does.
- `PluginStorage` becomes promise-returning for everybody (`0016:247-248`),
  so `code.*` handlers are async from the start; the capability ceiling is
  drawn from the closed nine (`capabilities.ts:11-22`), and "may launch on
  machine X" has no name until atyrode/manifold#154 and #157.

Manifold prerequisites: atyrode/manifold#151, #152, #153, #154, #155. Code
work: "Plugin package and manifest: `code.<x>` namespace, out-of-tree, no
vendoring" (#TBD).

### D2 Launch authority stays on the spoke

The enrolled machine's `code` binary — already on PATH through the dotfiles
wrapper with the whole `CODE_*` and `OMP_AUTH_BROKER_*` environment
(`default.nix:1495-1530`) — gains a headless verb `code launch --selection
<json>` that does exactly what Enter does today: the overlay
(`routing.go:771-862`), `sessionFlags` (`:864-874`), the worktree
(`main.go:65-79`), the session record (`session.go:561`), the child in the
current PTY (`launch.go:63-75`). The plugin never assembles omp argv and never
holds broker credentials.

Interim: the browser half opens a manifold terminal on the chosen machine
(`terminal_open` with `machineId`, `cwd` = project dir, `placement: "tile"`),
waits for the shell prompt, and types `code launch --selection '<json>'\n`
through `terminal_input`, labelled interim in the UI: plane-rule legitimate
channel traffic (`AXIOMS.md:133-135`). End state: `terminal_open` carries a
command, the PTY execs `code launch`, and nothing is typed.

Consequences:

- The selection document is the contract between the two halves: facet
  values, launch kind (`generated | managed | untrusted | runtime`), worktree
  flag, first prompt, forwarded argv. The TUI's Enter produces the same
  document and calls the same function, so the TUI is a client of the verb.
- Liveness stays the flock (`session.go:12-15`): `code launch` is the live
  parent inside the PTY, as `code` is today.
- Nothing rides env (`terminal-broker.ts:535-543`): the selection rides argv,
  the overlay a temp file on the spoke. The keystroke interim has a race (§7)
  and needs `code` on the PATH of a non-login interactive `$SHELL`.

Manifold prerequisites: "Session-channel `terminal_open` should carry a
command/argv" (#TBD); "`SessionHandle` has no plugin-facing terminal handle"
(#TBD); atyrode/manifold#153. Code work: "Headless `code launch --selection
<json>`" (#TBD), which owns the selection document's schema and the TUI
parity test.

### D3 Projections flow spoke to hub, Babel's D2 shape

A per-machine `code publish` service, OS-supervised by dotfiles as
`manifold-agent` is (`~/nix-dotfiles/modules/home/profiles/manifold-node.nix:27,34-44`),
runs as an agent-kind principal with a token the ceremony delivers beside the
machine token. It posts through `code.*` doors: the catalog (one `plugin_kv`
key per combo, never one key for the 206 KiB file), the usage snapshot
(non-secret fields only), the omp version, and the live session registry.
The browser half reads through `usePolledResource` and events. The hub
(Clever Cloud, `fleet/manifold.json:4`) cannot reach the auth broker
(loopback on dev-01), so nothing about usage runs hub-side.

Consequences:

- Each `code.*` publish door validates, stores, and emits one event; the
  server half is a thin projection store with no timer, no fetch.
- `code publish` is the one process that reads the broker and publishes only
  what the usage panel renders; it shares the session registry directory
  with `code launch`, so a launch is visible on the next `sessions_changed`.

Manifold prerequisites: none for the doors; atyrode/manifold#155 for an
isolated server half that must read a local companion (code's does not: the
spoke pushes). Code work: "`code publish` projections service + agent-kind
principal" (#TBD), which owns the catalog projection shape. Dotfiles: §8.4.

### D4 UI shape: `code.launcher` now, `code.launchpad` later

End state: a composition-shaped discipline `code.launchpad` whose container
shows the dial pane and a tile tree of launched terminals in one view, the
terminal above the launcher; blocked by atyrode/manifold#134 and by a new
issue for a discipline renderer hosting plugin UI beside terminal tiles (N4).
Interim: a `code.launcher` panel or seat with the dials; a launch opens the
terminal with `placement: "tile"` into the composition in view, or into one
code creates through `core.index.createContainer` and `navigate`s to. The
spike (D1) decides which interim is viable.

Consequences:

- The interim never places a terminal beside the panel: the workspace tree
  refuses terminal leaves (`shell/src/server.ts:108-109`).
- A discipline renderer today dials its own room pipe with `host.token`
  (`projection.ts:167-168`), the affordance ADR 0016 removes; the end-state
  renderer is written against whatever the isolation runner offers.

Manifold prerequisites: atyrode/manifold#134; "A discipline that hosts plugin
UI beside a live terminal tile in one addressable view" (#TBD);
atyrode/manifold#160 (widened with code's inventory, §8.1). Code work:
"Interim panel launcher (`code.launcher`)" (#TBD); "Launchpad discipline
(`code.launchpad`), end state" (#TBD).

### D5 Secrets never enter manifold

The broker token, the DeepSeek key and the account pool stay on the machine.
The account manager's non-secret toggles and presets
(`vault.go:461-490,615`) ride `code.*` doors; OAuth login (`a`,
`manager.go:475`) and `CODE_AUTH_LOGIN_VIA` (`:314`) stay CLI-only.

Consequences:

- No `code.*` action accepts a field matching `SECRET_FIELD` (`log.ts:36`)
  and none needs to; a lint on the action schemas enforces it.
- `code publish` strips `apiKey`, `credentialID` and block internals before
  posting; the usage projection carries what `usage.go` renders.
- `withAuthEnv` (`vault.go:881-889`) runs only inside `code launch` on the
  spoke.

Manifold prerequisites: none. Code work: folded into "`code publish`" (#TBD)
and "Usage/account surfaces as browser-rendered plugin UI" (#TBD).

### D6 Scope

The Babel-worker half (§3.1, 51.6 % of non-test bytes) belongs to Babel's
transition, not to the launcher plugin. Stays CLI-only: `code generate
[init]`, `code session` / `code ls` / `reap`, `code wt`, the onboarding
scaffold, `code babel*`.

Consequences:

- The ceremony (`code babel --configure`) drives the same generator TUI
  (`babelconfigure.go:3`); when step 6 retires the TUI the ceremony must
  consume a selection document instead, which is a Babel follow-up (§8.3).
- Onboarding's review step may become a surface at step 5; its probe never
  does.

---

## 6. Transition steps

Each step names its manifold prerequisites and code work by draft title, its
proof, and what it retires; the two halves run in parallel and a step is done
only when both are.

### Step 0. Today

Code is a Go binary whose only launcher is a Bubble Tea TUI (`main.go:58`)
that blocks on the child it launches (`launch.go:63-75`). Manifold has no
loader for out-of-tree code, no command on `terminal_open`, no terminal leaf
in the workspace tree, no plugin-facing `openTerminal`, boolean settings, and
64 KiB `plugin_kv` values. One machine is enrolled (`fleet/manifold.json:9-11`).

### Step 1. Headless launch, projections, package skeleton (host-independent)

Code: "Headless `code launch --selection <json>`" (#TBD) — the document's
schema, the verb, and the TUI's Enter calling it; "`code publish` projections
service + agent-kind principal" (#TBD) — the doors, the catalog split, a
`--once` mode for tests; "Plugin package and manifest" (#TBD) — `plugin/`
with manifest, `code.*` actions as data, handlers over `ctx.storage`, a flake
output for the artifact.

Manifold, in parallel: atyrode/manifold#151, #152, #153, #154. The docs/spikes
entry (D1) sizes atyrode/manifold#160 with code's dials and preview.

Proof: `code launch --selection` from a plain shell launches the same omp
argv, overlay and session record the TUI does, proven by a parity test that
feeds both paths one document; `code publish --once` against a local hub
writes one key per combo, all under 64 KiB, and the inspector's door form
reads `code.catalog.get`; the trace rows exist.

Retired: nothing. From this step on `update.go` gains no launch behaviour
that is not in the verb.

### Step 2. Interim panel launcher over keystrokes

Manifold: "`SessionHandle` has no plugin-facing terminal handle" (#TBD), or
the in-realm `host.token` path while it exists; atyrode/manifold#153.

Code: "Interim panel launcher (`code.launcher`)" (#TBD) — dials from the catalog
projection, a machine picker from `client.machines()`, a launch that opens a
terminal with `placement: "tile"` into the composition in view or a
code-created one, waits for the prompt, types `code launch --selection`, and
shows the interim label. Dotfiles: the `code publish` unit and its token (§8.4).

Proof: from a browser, an operator picks a machine, turns the dials, and
presses launch; a terminal appears in a composition on that machine running
omp with the chosen profile; `code ls` on the machine lists the session; the
plugin shows it from the projection; no `omp` argv and no credential crossed
the wire.

Retired: nothing; the TUI stays.

### Step 3. The launchpad discipline

Manifold: atyrode/manifold#134; "A discipline that hosts plugin UI beside a
live terminal tile in one addressable view" (#TBD); "Session-channel
`terminal_open` should carry a command/argv" (#TBD).

Code: "Launchpad discipline (`code.launchpad`), end state" (#TBD) — the container shows the dial pane
and the launched terminals in one tile tree, terminal above the launcher; a
launch execs `code launch` in the PTY directly.

Proof: one container, one view: dials below, a running omp above, the exit
of one terminal leaves the pane; no keystroke is typed by the plugin; the
interim label is gone.

Retired: the keystroke path and its label.

### Step 4. Usage and the account manager

Manifold: atyrode/manifold#158 for a default-lane setting pane.

Code: "Usage/account surfaces as browser-rendered plugin UI" (#TBD): windows
and blocks from the projection; toggles and presets through `code.*` doors;
login CLI-only.

Proof: the browser shows the same quota windows, reset countdowns and blocks
the TUI shows, refreshed by `code publish` on its cadence with no timer in
the browser (`REGISTRY.md:1986-1999`); toggling an account in the browser
changes the next launch's pool on the machine; no key or token appears in
any `code.*` payload or trace row.

Retired: nothing yet.

### Step 5. Every surface

Manifold: atyrode/manifold#160.

Code: "Routing preview, suggest box and onboarding review as plugin surfaces"
(#TBD). The suggest box calls the machine's Ollama through `code publish`;
onboarding's review reads a scaffold `code generate init` produced on the
machine.

Proof: every operator task the TUI supports is performed in manifold through
the plugin with no TUI running, by an operator, on the enrolled machine.

Retired: nothing yet; the TUI stays until this proof is recorded.

### Step 6. Retire the TUI

Code: "Retire the TUI" (#TBD). Bubble Tea,
`view.go`, `layout.go`, `render.go`, `wheel.go`, the glyph tables and
`CODE_SYMBOLS`/`CODE_FACET_GLYPHS` go; bare `code` becomes a headless status
overview. Babel: the ceremony consumes a selection document (§8.3) before
`babelconfigure.go`'s TUI use is removed.

Proof: `code` with no arguments prints status and launches nothing; `code
launch --selection` is the only launcher; the ceremony passes Babel's
conformance without a TTY.

What stays CLI-only, and why. Recovery must work when the plugin UI, the hub
or the network is unreachable, so every projected fact keeps a headless
reader, and the following never get a door: `code launch --selection` (the
launch itself; its door is the terminal); `code session`, `code ls`, `code
session reap` (flock liveness and process signals on one machine,
`session.go:12-15,363-389`; the plugin shows the registry and never signals
a PID); `code wt`, `remove`, `prune` (git on a local checkout); `code
generate [init]` (minutes of probing through `omp`,
`generate_init.go:878-918`; the result is published, the run is not driven);
`code babel ...` and the ceremony (D6); OAuth login and `CODE_AUTH_LOGIN_VIA`
(interactive, credential-bearing, D5); `code publish` itself (an
OS-supervised service, driven by dotfiles).

### Cross-cutting manifold improvements

Not prerequisites; each was found on the path and has an evidenced case
(§8.1): A2 false for terminal creation, and the action comment that invites
the confusion; the synchronous-on-purpose storage contract already scheduled
to flip; the authoring guide's in-tree-only channel left unsaid;
`contributes.disciplines` undocumented; no atomic multi-door composition; the
64 KiB ceiling without a rationale; a machine row that cannot say what
binaries it has or that it was refused at dial.

---

## 7. Gotchas

Every ceiling or rule that bites code specifically, in the order it bites.

- **64 KiB values against a 206 KiB catalog.** `MAX_STORAGE_VALUE_BYTES = 64 *
  1024` (`storage.ts:74`) and `testdata/two-pool-golden.plain` is 211,213
  bytes. One key per combo (`comboID`, `routing.go:385`), keys at most 128
  characters (`storage.ts:58`); an index key lists the combos and a hash.
- **The keystroke race.** `terminal_opened` answers when the PTY exists, not
  when the shell has printed a prompt; input typed before the shell reads its
  rc files is consumed by whatever is reading stdin then. The interim waits
  for output before typing and types once; the end state removes the typing.
- **`machineId` with one enrolled spoke.** `terminal_open.machineId` is
  optional (`session.ts:202`); absent means the broker's fleet rule. With
  `spokes: ["dev-01"]` (`fleet/manifold.json:9-11`) the picker has one
  entry; the launcher must still send the id, not rely on the default.
- **`MANIFOLD_TOKEN` is scoped to the terminal.** It is minted per terminal
  and container-scoped (`terminal-broker.ts:542`); `code launch` may use it to
  name its terminal in the session record and for nothing else.
- **No env passthrough.** The PTY gets four keys and the agent's own
  environment minus `MANIFOLD_*` (`agent/terminal.ts:131-146`); the selection
  is argv, the overlay is a file the spoke writes.
- **`code` on the PATH of a non-login interactive shell.** The agent spawns
  `$SHELL` with no `-l` (`agent/terminal.ts:121-129`); `code` reaches PATH on
  dev-01 through Home Manager's system profile
  (`~/nix-dotfiles/lib/configurations.nix:66-67`) and the wrapper recomputes
  its variables on every call (`default.nix:1495-1530`). A spoke whose profile
  exports PATH only for login shells types a command that fails.
- **No `openTerminal` on `SessionHandle`.** A panel that wants a terminal
  today mints a `SessionClient` from `host.token` as the renderers do
  (`composition-view.tsx:180-182`); that token is withdrawn under isolation
  (`0016:229-231`).
- **Three doors, no transaction.** Authorize, open, place are independent
  round trips (`host.ts:53-54`; no `ctx.dispatch`); an open that succeeds
  and a place that fails leaves a legal, unplaced terminal in its solo home.
- **Workspace leaves are panels.** `setLayout` refuses a terminal leaf
  (`shell/src/server.ts:108-109`); "above the launcher" is a composition, and
  a third-party tile-tree discipline half-works until atyrode/manifold#134
  (`placement.ts:339,1588`).
- **Boolean settings, per principal; closed nine caps.** `SETTING_KINDS =
  ["boolean"]` (`plugin.ts:104`); `terminals:spawn` is the nearest cap for
  "launch" and does not scope to a machine (#154, #157).
- **Emission only inside a dispatch.** `ctx.emit` flushes on `ok`
  (`plugin-host.ts:340-349,1207-1210`); `code publish` gets its event by
  calling a door, never by writing storage.
- **Synchronous storage, scheduled to flip.** `storage.ts:12` says
  "SYNCHRONOUS on purpose"; `0016:247-248` migrates it to promises for all
  plugins. Write `code.*` handlers async now.
- **The Budgets register.** No timer beside a live subscription
  (`REGISTRY.md:1986-1999`); the usage cadence lives in `code publish`.
- **Redaction by name.** `SECRET_FIELD` (`log.ts:36`) would redact a field
  named `credentialID` and pass one named `balance`; publish neither.
- **Agent restart kills every PTY** (`docs/ENROLL.md:157`); a `manifold-agent`
  pin bump on dev-01 ends every launched omp. `code ls` still knows.

---

## 8. Draft issues

Numbers are assigned when filed; every `(#TBD)` below becomes one. Titles are
the ones settled with the issue drafts of the same date, so the record and the
filings agree word for word.

### 8.1 Manifold

Classes: `[prerequisite]` (code cannot reach a step without it), `[design]` (a
contradiction or smell worth raising regardless), `[improvement]` (general).

**`[prerequisite] Session-channel terminal_open should carry a command/argv,
not force every PTY through a login shell`** (#TBD, step 3). Problem: the only
thing a PTY can run is `$SHELL`; a launcher must type its command after a
prompt it cannot detect reliably. Evidence: `packages/protocol/src/session.ts:192-210`
(no command field); `packages/protocol/src/machine.ts:76-86` (`create` has
none); `packages/agent/src/terminal.ts:114-129,163-167,199` (`opts.command ??
resolveShellCommand()` is already a DI seam); `AXIOMS.md:133-135`. Distinct
from atyrode/manifold#156 (no PTY, no viewer): this asks for a PTY with a
program in it. Acceptance: `terminal_open` and `create` carry an optional
`command: string[]`; the agent spawns it in the PTY under the same env rule;
`core.terminals.open` sees it in its arguments; an older agent answers
`create_error` with a named reason; `PROTOCOL_VERSION` bumps in a dedicated
commit; a testkit e2e runs `/bin/echo` in a terminal and reads its exit;
`docs/CONTRACTS.md` §machine channel documents the field.

**`[prerequisite] SessionHandle has no plugin-facing terminal handle; shipped
renderers escape it with a self-minted SessionClient using host.token, which
isolated plugins will not have`** (#TBD, step 2). Evidence:
`packages/plugin/src/host.ts:49,52-115`;
`packages/plugins/compositions/src/composition-view.tsx:180-182`;
`packages/plugins/terminals/src/terminal-view.tsx:41,432`;
`packages/plugin/src/projection.ts:167-168`;
`docs/decisions/0016-plugin-isolation.md:221-231`. Acceptance: `SessionHandle`
(or an isolation-safe RPC) offers `openTerminal` and `sendTerminalInput`
gated by `terminals:spawn` and the controller lease; the shipped renderers
use it instead of a private client; `docs/PLUGINS.md` §Host services names it.

**`[prerequisite] A discipline that hosts plugin UI beside a live terminal
tile in one addressable view`** (#TBD, step 3). Problem: a plugin pane can be
a workspace leaf and a terminal a composition leaf, but no tree may hold
both. Evidence: `packages/protocol/src/layout.ts:85-108` (one `TileRef`
union); `packages/plugins/shell/src/server.ts:103-111` (workspace refuses
terminals); `packages/server/src/placement.ts:339,1588` (census and
`removeTile` decided by literal); `packages/protocol/src/placement.ts:390-397`
(`DisciplineDefSchema` declares guards and destinations, not leaf kinds).
Acceptance: a third-party discipline declares that its tree accepts a
plugin-owned pane leaf; `place` lands a terminal into such a tree; the
renderer receives its pane as a leaf and terminal tiles as projections;
atyrode/manifold#134's `acme.sheets` fixture covers it.

**`[design] HTTP-reachable terminal creation, so axiom A2 holds for terminals
as it does for every other door`** (#TBD). Evidence:
`packages/protocol/src/session.ts:192-210` (socket only);
`packages/plugins/terminals/src/server.ts:56-68` (the action returns `{}`);
`AXIOMS.md:41-44` ("no API-only path"; there is a socket-only path).
Acceptance: either an HTTP path creates a terminal, or `AXIOMS.md` names the
PTY plane's exception.

**`[design, docs fix] core.terminals.open's own comment reads as though the
action creates the terminal`** (#TBD). Evidence:
`packages/plugins/terminals/src/index.ts:87-100` ("Everything a policy could
want to judge is in the arguments ... lands here and nowhere else");
`docs/PLUGINS.md:3-4` (an author is told not to read the source). Acceptance:
the manifest comment and `docs/PLUGINS.md` §Actions say the action
authorizes and the frame creates.

The one-`TileRef`-two-vocabularies smell (`layout.ts:85-108` against
`shell/src/server.ts:108-109`, unstated in `docs/CONTRACTS.md:348` onwards)
is not filed on its own: the discipline issue above resolves and documents it.

**`[design] PluginStorage's "synchronous on purpose" doc contradicts ADR
0016's ratified async migration, with no stated migration story`** (#TBD).
Evidence: `packages/plugin/src/storage.ts:12-14`;
`docs/decisions/0016-plugin-isolation.md:10-11,247-248`; `docs/PLUGINS.md:485-550`
(no mention). Acceptance: §Your data states the scheduled change, or the
promise-returning interface lands ahead of the runner as its own change.

**`[design, docs fix] docs/PLUGINS.md promises source-free authorship while
its own text tells the reader to go read manifold's source, and never states
the current channel is in-tree-only`** (#TBD). Evidence: `docs/PLUGINS.md:3-4`
against `:1103` ("Read `packages/web/src/assembly.ts` ... for the shapes");
`AXIOMS.md:53-56,304-312` (the authoring half is "unproven");
`packages/server/src/assembly.ts:61-63`. Acceptance: the guide states that
authoring today means a workspace package registered in two assembly files,
and points at atyrode/manifold#151/#152.

**`[improvement] contributes.disciplines is never documented in
docs/PLUGINS.md, despite being what a third-party tile-tree discipline depends
on`** (#TBD). Evidence: `packages/protocol/src/plugin.ts:346-362`;
`packages/protocol/src/placement.ts:390-397`;
`packages/plugin/src/projection.ts:160-183`; the guide never names the kind
(§2.2). Acceptance: a subsection under §6 with the manifest row, the renderer
props, and #134's caveat.

**`[design] No atomic multi-door composition, and no documented
compensating-action idiom`** (#TBD). Evidence:
`packages/server/src/plugin-host.ts:249-350` (no `ctx.dispatch`);
`host.ts:53-56`; `docs/CONTRACTS.md:1415-1418` (an unplaced terminal is legal
in its solo home). Acceptance: `docs/PLUGINS.md` names the idiom (open, place,
on failure `removeContainerTile` or kill), or one door does both.

**`[improvement] MAX_STORAGE_VALUE_BYTES's 64 KiB ceiling has no stated
rationale, and no blob class for catalog-sized plugin data`** (#TBD,
references atyrode/manifold#159). Evidence: `storage.ts:74`; `http.ts:36`
(1 MiB bodies); `testdata/two-pool-golden.plain` at 211,213 bytes.
Acceptance: a comment or ADR line naming the tradeoff; #159 cites a value
read whole and written rarely as its second instance.

**`[improvement] Machine roster row (MachineSummary) should expose declared
host capabilities`** (#TBD, with atyrode/manifold#153). Evidence:
`packages/protocol/src/http.ts:322-338` (`id, name, online, color?, revoked?`);
the launcher needs "this machine has `omp` ≥ 17.3 and `code`"
(`routing.go:814-819`). Acceptance: an agent-reported capability list on the
row, fed by the manifest declaration #153 adds; a machine lacking one is
greyed in the picker.

**`[improvement] No health/readiness surface for "agent dialed the hub and
was rejected" (4409 is silent)`** (#TBD). Evidence: `http.ts:322-338`
(`online` only); `docs/ENROLL.md:155-174`; `~/nix-dotfiles/docs/manifold.md`
"Protocol mismatch is silent". Acceptance: the row carries the last dial's
outcome; the machines section renders it; v21 readers are unaffected.

Comments on existing issues, not new filings: atyrode/manifold#160 — widen
the sizing input with §3.3; atyrode/manifold#156 — a session-channel PTY-exec
shape is also needed, distinct from #156's no-PTY job; atyrode/manifold#153
— `omp` with a version floor, and `code`; atyrode/manifold#134 — the
launchpad is its second instance; atyrode/manifold#157 — "may launch on
machine X" is code's grant.

### 8.2 Code

| Title | Step | Acceptance |
| --- | --- | --- |
| Plugin package and manifest: `code.<x>` namespace, out-of-tree, no vendoring (#TBD) | 1 | `plugin/` with manifest `code.launcher`, `code.*` actions as data, handlers over `ctx.storage`, events declared; builds to a hashed artifact from the flake; manifests parse against `@manifold/protocol` at 21. |
| Headless `code launch --selection <json>` (#TBD) | 1 | A versioned document (facets, launch kind, worktree, first prompt, forwarded argv; unknown keys refused; `-` reads stdin); the verb builds the overlay and flags, creates the worktree if asked, opens the session record, runs the child as `runChild` does, exits with its status; the TUI's Enter calls it; a parity test feeds one document to both paths and compares argv, env keys and overlay bytes. |
| `code publish` projections service + agent-kind principal (#TBD) | 1 | Runs from a token file; posts catalog (one key per combo under 64 KiB, an index key, a content hash), usage (non-secret), omp version and sessions through `code.*` doors on the usage cadence and on registry change; `--once` for tests; backoff; never logs a token; a secret-field lint on every payload; the two-pool golden fits. |
| Interim panel launcher (`code.launcher`) (#TBD) | 2 | Dials from the projection; machine picker; launch opens a terminal on the machine with `placement: "tile"`, waits for output, types the verb once; labelled interim; step 2's proof recorded. |
| Launchpad discipline (`code.launchpad`), end state (#TBD) | 3 | A container with the dial pane and terminal tiles; launch execs the verb through the command field; step 3's proof recorded. |
| Usage/account surfaces as browser-rendered plugin UI (#TBD) | 4 | Windows, countdowns, blocks and balance from the projection with no browser timer, parity with `usage.go` on a fixture; toggles and presets through `code.*` doors change `CODE_AUTH_ACCOUNT_STATE` on the machine; login stays CLI. |
| Routing preview, suggest box and onboarding review as plugin surfaces (#TBD) | 5 | Every `keys.go` binding has a browser equivalent or a recorded retirement. |
| Retire the TUI (#TBD) | 6 | Bubble Tea and the rendering files deleted; bare `code` prints status; the ceremony no longer needs the TUI. |
| Dotfiles follow-ups for the launcher plugin (#TBD) | 2 | The §8.4 items, tracked from code's side. |

### 8.3 Babel follow-ups

- Transition record cites retired `dev@68f102e`; re-pin to `main@8466628`
  (v0.6.2). Several line numbers moved: `uri.ts:33-45`,
  `agent/terminal.ts:114-129`, `machine.ts:36-92`, `CONTRACTS.md:147-151`,
  `assembly.ts:61-76`. (#TBD)
- The configure ceremony drives code's TUI directly; it must consume the D2
  selection document instead, before code's TUI retires. `analysis profile
  configure` hands the terminal to `code babel --configure`
  (`babelconfigure.go:3,113-117`); Babel's conformance suite must pass
  without a TTY. (#TBD)

### 8.4 Dotfiles and infra follow-ups

- A `code publish` user service beside `manifold-agent`
  (`modules/home/profiles/manifold-node.nix:27,34-44` is the pattern), and
  the ceremony that mints its agent-kind token beside the machine token. (#TBD)
- A check that `code` resolves on the PATH of a non-login interactive
  `$SHELL`, on every spoke. (#TBD)
- Enroll `macbook` and `wsl`: v0.6.2 ships `manifold-agent-darwin-arm64`
  (`CHANGELOG.md:9`), so `supportedSystems` (`fleet/manifold.json:6-8`) can
  widen; the picker is otherwise a list of one. (#TBD)
- atyrode/tyrode-infra: the stale production vhost `manifold.tyrode.dev ->
  127.0.0.1:7777` on dev-01 (`modules/machines/tyrode-dev-01-manifold.nix:6,14`
  at `1ae15d7`) contradicts `fleet/manifold.json:3` and
  `modules/nixos/manifold-dev-hub.nix:1-5`. (#TBD)
