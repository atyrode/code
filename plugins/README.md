# Code's Manifold plugin

Code is TypeScript domain logic and governed actions, React web surfaces and
Bun machine workers. Manifold is the application and owns resources, grants,
consent, persistence and execution. OMP is the agent runtime. The
[transition ledger](../docs/manifold-transition.md#6-transition-steps) is the
sole progress record; source descriptions here do not imply merge or deployment.

## Family and source map

All five bundles are packed from one tree; each child requires `atyrode.code`.

| Directory | Plugin / surface |
| --- | --- |
| `atyrode.code/` | `atyrode.code`: governed product/execution-service actions and native machine manifest |
| `atyrode.code/gateway/` | `atyrode.code.gateway`: independently installed native model gateway, with no operator-facing panel |
| `atyrode.code/generator/` | `atyrode.code.generator`: `launcher` React panel, catalog editor, dials, resources, probes, suggestions and terminal launch |
| `atyrode.code/accounts/` | `atyrode.code.accounts`: `accounts` React panel, shared choices/presets and native OMP sign-in administration |
| `atyrode.code/usage/` | `atyrode.code.usage`: `usage` React panel and permitted account observations |

- `domain/contracts.ts`, `catalog.ts`, `routing.ts`, `providers.ts`: typed
  catalogs, ladders, selections, estimates and the final OMP overlay boundary.
- `domain/accounts.ts`, `usage.ts`, `probe.ts`, `suggestions.ts`: identity/slot
  selection, freshness, typed probe receipts and suggestion validation.
- `atyrode.code/contract.ts`, `server.ts`, `state.ts`: action schemas, governed
  handlers and container/machine-scoped native storage with compare-and-set.
- `atyrode.code/execution.ts`, `machine-server.ts`: exact resource resolution,
  native jobs, retained results and reviewed terminal-runtime construction.
- `atyrode.code/service-setup.ts`, `service-policies.ts`, `broker.ts`: native
  instance broker setup, separate owner-only machine execution-service policies
  and scoped service operations.
- `atyrode.code/auth-contract.ts`, `auth-server.ts`, `accounts/server.ts`:
  shared broker identity, exact-revision setup and native sign-in terminal handoff.
  `omp-sign-in.tsx` opens that terminal and refreshes permitted account metadata;
  OMP owns login, API keys, credential storage and refresh.
- `workers/probe/`, `workers/broker/`, `workers/gateway/`: machine-local SDK
  adapters. The broker hosts OMP's auth service under native instance lifetime.
  The gateway is a job-owned scoped OMP protocol adapter, not a
  provisioning daemon, credential authority or separate operator product.
- `workers/build.ts`, `runtime-artifacts.json`, `pack.ts`: worker bundle
  generation, upstream artifact/hash pins and five-bundle packing.
- `test/` and colocated `*.test.ts`: native contract and domain regressions.

Headless clients invoke root actions as `atyrode.code.<action>` and sign-in
administration as `atyrode.code.accounts.readAccountSetup` or
`atyrode.code.accounts.prepareSignIn` through Manifold's action API. `ActionInput`,
`ActionResult`, the schemas and `actionDoor` in `contract.ts` define the typed
boundary. Clients do not spawn Code or parse output.
Babel may adopt this boundary independently. Code neither depends on Babel nor
claims its adoption, and does not preserve a former engine process ABI for it.

## Pinned SDK and development gate

Use **Bun 1.4.2** and the Manifold revision in `MANIFOLD_REV`:

```text
<parent>/
  code/plugins/
  manifold/       exact SDK checkout selected by code/plugins/MANIFOLD_REV
```

`tsconfig.json` maps the public plugin, hooks, worker, protocol, UI, SDK and
scene imports to the sibling's source. Server host types come from
`@manifold/plugin-kit/server`; runtime clients use the public native APIs.
Keep `MANIFOLD_REV` and `.github/workflows/manifold-plugins.yml`'s reusable
workflow reference synchronized. Do not claim a pin is valid until it identifies
an available exact platform revision.

From the Code root, `scripts/gate.sh` checks the Bun/SDK prerequisites,
frozen-installs both workspaces and runs the plugin gate. Its component commands
are, after `bun install --frozen-lockfile` in Manifold and in `code/plugins`:

```sh
# In code/plugins, with Bun 1.4.2
bun run check
bun run test
bun run pack
bun run verify
```

`check` typechecks the TypeScript/React sources. `test` runs the Bun suite.
`pack.sh` invokes `pack.ts`, which stages sources privately, bundles workers,
adds managed artifact declarations and packs parent before children through the
pinned kit. Output is `dist/<id>.manifold-plugin.json`, `dist/SHA256SUMS` and
`dist/native-requirements.json`. Source manifests own operations and requirements;
packing does not rewrite them or install a worker on an execution machine.
`verify` first uses the kit's disposable server to install, dispatch and uninstall
bundles, then runs `scripts/verify-browser.ts` against the packed artifacts.
The browser scenario requires Chromium (`MANIFOLD_CHROMIUM` can select its binary)
and uses two isolated, freshly minted Manifold identities to prove viewer write
refusal and live initialization/profile convergence. It starts no native job
owner, terminal or provider request. Run `bun run verify:browser` independently,
or pass an existing bundle directory to `bun scripts/verify-browser.ts` to check
older artifacts. Neither the browser scenario nor the other gate commands prove
live provider authentication or OMP readiness.
The unit suite exercises isolated synthetic brokers without provider requests,
covering pool membership, revocation, shutdown persistence, reconnect ordering
and delayed credential mutation replies. A locked Bun patch to `@oh-my-pi/pi-ai`
keeps those replies out of the canonical cache and preserves caller deadlines
while snapshot reads queue, alongside the shutdown and reconnect fixes. The patch
is used by the bundled broker and gateway workers. It does not modify the
separately pinned OMP executable.

## Managed execution resources

`runtime-artifacts.json` pins Bun 1.4.2, OMP/SDK 18.1.14 and pi-natives artifacts
for Linux x64/arm64 with upstream/archive-member hashes. The native owner resolves
and admits exact artifacts and operation resource bindings. All machine
operations require **`runtimeTools.system`**, an independently reviewed and
promoted interpreter/library closure. The requirements report lists direct ELF
requirements, not a complete provisioned transitive closure. Unconfigured
owners must refuse admission. No host PATH, filesystem discovery or incidental
cache substitutes for this resource.

Ordinary `atyrode.code.launch` also requires the owner-reviewed `development`
tool group and the managed Bun executable. Declare a shell at `/bin/sh`, Bash
and normal coding commands on `/usr/bin`, including Git and Python 3.10+,
together with their complete runtime closures. OMP's Python runner requires
no Jupyter or additional pip packages. Manifold's
`execution.runtimeToolClosures` can expand explicitly selected Nix packages;
it never mounts the whole host store. These are private job resources, not
global host packages or borrowed project environments. Project-specific build
dependencies remain the workspace's responsibility. Account sign-in and
service workers do not acquire this broader coding tool group.

The `system` group must also provide the owner's reviewed public resolver at
`/etc/resolv.conf` and CA bundle at `/etc/ssl/certs/ca-certificates.crt`. Native
Code operations declare `SSL_CERT_FILE` at that in-job path; ordinary launch
also declares `GIT_SSL_CAINFO`. Host networking does not supply these files or
inherit the host environment.

Native Plugins manages installation, resource/location bindings, consent and
retained job lifecycle. First review/install the declared instance owner's system
and managed `atyrode.code.accounts.omp-auth` bindings. Accounts owns the independent
`atyrode.code.accounts.broker` and `atyrode.code.accounts.sign-in` operations.
Both operations require exact native `machines:run` and `network:host` consents;
their managed auth location also requires `locations:write`. Installation
readiness alone does not authorize sign-in or broker startup.
`readAccountSetup` observes the configured owner, or the native default owner
before configuration; `prepareSignIn` creates or reuses that owner's instance
broker at the expected native revision and returns the exactly pinned terminal
runtime. The web surface places it on that owner, not the workspace machine.
An unavailable owner is a refusal, not permission for discovery or failover.
The managed home keeps its existing `code/shared-omp` state components and
`/home/job/omp` guest path. Broker startup and sign-in need neither a gateway
installation nor root workspace resources.
An enabled but unavailable broker requires explicit runtime review and apply.
Recovery issues a revision-bound replacement even when its runtime pins are
unchanged, using one native compare-and-set rather than disabling the shared
service first. Reading setup or opening ordinary sign-in never restarts it.
The terminal's ordinary OMP `/login` flow writes its owner-local shared store.
Code refreshes only permitted metadata and offers Continue once a fresh account
appears; OMP can stay open to add more. Native grants let authorized machines
share the broker without moving credentials into Code.

Then review/install the gateway's accounts-broker/system bindings.
`readServiceConfiguration`, `reviewServices` and `configureServices` manage only
the machine's `omp` gateway and optional `suggest` classifier policies. Review
derives the ready gateway's exact runtime pins, and configuration commits the
reviewed native revision/digest while preserving unrelated policies. These
actions neither configure instance authentication nor accept credential inputs.
Finally, review/install the root's service/system/location bindings and approve its
bounded native invocation edges. Accounts, gateway and root have separate native
installations: promoting workspace or gateway bindings does not replace the
running broker/sign-in installation. Code's resource promotion adopts these
exact pins; it does not install or grant consent. No step creates a private
provisioning daemon or supplies the owner's system closure.
`prepareWorkspace` requires `mode: "create" | "existing"` with the current
`expectedRevision`. Creation dispatches native `prepare-workspace`, which creates
the declared new workspace/session locations exclusively and refuses existing
directories. Existing-folder validation dispatches separate `validate-workspace`
with read-only bindings: both directories must already exist, and validation
preserves them without creating anything. Both routes run the same pinned,
no-network OMP version probe as a native job; neither clones a repository.
Approve one route's exact native consent, not both create and read grants.
Model discovery and launch still need their own permissions; repeated launches
use separately consented write access.
First-use completion follows a successful retained job from either workspace
operation matching the current installation revision, artifact hash and that
operation's resource binding digest. Runtime pin changes require a new successful
proof. Both native histories are refreshed, so reload preserves completion
without a local browser shortcut, blind creation fallback or skipped runtime check.
The native permission-review action remains reachable before model-connection
setup, including when the required invocation consent has not yet been granted.

## Publication and mutation authority

CI runs the plugin gate. The tag-only release workflow publishes plugin bundles
and their checksums, not standalone binaries. Published release bytes, tags and
hashes remain immutable; corrections need a new version. A release is not an
installation or machine activation. Production installation remains operator-only
from the release URL in native Plugins, never automated by this task.

Releases are artifact-only: CI installs nothing on preview or production.
The React panels use Manifold's normal in-realm renderer, not its hardened
`PanelProgram` worker renderer. The operator reviews that execution trust and
the exact bundle before installation through native Plugins, parent before
children. Machine installations, service policies and consent remain separate
explicit native actions. Source verification performs no tag or delivery.

`bun run dev -- --hub <development-hub-url> --deliver <delivery-target>` builds
Code's generated workers and all five bundles through the native kit's development
loop, then installs and watches/reinstalls changed bundles, parent before parts.
Use only an explicitly authorized development target, not to establish status on
a shared environment. Reload the browser after a successful cycle; plugin Update
checks published bundles, not this working source.
Restart the command after changing the development driver or build scripts
themselves; ordinary plugin source edits are picked up by the running loop.

No actual deployed revision or live broker/account proof is supplied here.
Report Code/Manifold revisions, bundle hashes and the actual exercised surface
separately from merge, publication and operational acceptance. No release, live
deployment, credential relocation, broker retirement or destructive state change
is authorized by this guide.
