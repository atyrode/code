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
| `atyrode.code/` | `atyrode.code`: governed product/authentication actions and native machine manifest |
| `atyrode.code/gateway/` | `atyrode.code.gateway`: independently installed native model gateway, with no operator-facing panel |
| `atyrode.code/generator/` | `atyrode.code.generator`: `launcher` React panel, catalog editor, dials, resources, probes, suggestions and terminal launch |
| `atyrode.code/accounts/` | `atyrode.code.accounts`: `accounts` React panel, shared choices/presets, OAuth and API-key enrollment |
| `atyrode.code/usage/` | `atyrode.code.usage`: `usage` React panel and permitted account observations |

- `domain/contracts.ts`, `catalog.ts`, `routing.ts`, `providers.ts`: typed
  catalogs, ladders, selections, estimates and the final OMP overlay boundary.
- `domain/accounts.ts`, `usage.ts`, `probe.ts`, `suggestions.ts`: identity/slot
  selection, freshness, typed probe receipts and suggestion validation.
- `atyrode.code/contract.ts`, `server.ts`, `state.ts`: action schemas, governed
  handlers and container/machine-scoped native storage with compare-and-set.
- `atyrode.code/execution.ts`, `machine-server.ts`: exact resource resolution,
  native jobs, retained results and reviewed terminal-runtime construction.
- `atyrode.code/service-setup.ts`, `service-policies.ts`, `broker.ts`: owner-only
  native service-policy review/configuration and scoped service operations.
- `atyrode.code/auth-contract.ts`, `auth-server.ts`: typed OAuth controls and
  native enrollment lifetime. API-key enrollment uses native source references,
  not an OAuth worker prompt or a raw-key form.
- `workers/probe/`, `workers/auth/`, `workers/gateway/`: machine-local SDK
  adapters. The gateway is a job-owned scoped OMP protocol adapter, not a
  provisioning daemon, credential authority or separate operator product.
- `workers/build.ts`, `runtime-artifacts.json`, `pack.ts`: worker bundle
  generation, upstream artifact/hash pins and five-bundle packing.
- `test/` and colocated `*.test.ts`: native contract and domain regressions.

Headless clients invoke `atyrode.code.<action>` through Manifold's action API,
using `ActionInput`, `ActionResult` and schemas in `contract.ts`; enrollment
schemas live in `auth-contract.ts`. They do not spawn Code or parse output.
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
`verify` uses the kit's disposable server to install, dispatch and uninstall
bundles. None of these commands proves a live provider request or OMP readiness.

## Managed execution resources

`runtime-artifacts.json` pins Bun 1.4.2, OMP/SDK 18.1.14 and pi-natives artifacts
for Linux x64/arm64 with upstream/archive-member hashes. The native owner resolves
and admits exact artifacts and operation resource bindings. All machine
operations require **`runtimeTools.system`**, an independently reviewed and
promoted interpreter/library closure. The requirements report lists direct ELF
requirements, not a complete provisioned transitive closure. Unconfigured
owners must refuse admission. No host PATH, filesystem discovery or incidental
cache substitutes for this resource.

Native Plugins manages installation, resource/location bindings, consent and
retained job lifecycle. First review/install the accounts machine's system and
managed `atyrode.code.accounts.omp-auth` bindings. Accounts owns the independent
`atyrode.code.accounts.broker` and `atyrode.code.accounts.sign-in` operations;
its `readAccountSetup` and `prepareSignIn` administration actions configure the
instance `atyrode.code.accounts.broker` service and prepare the sign-in terminal.
The managed home keeps its existing `code/shared-omp` state components and
`/home/job/omp` guest path. Broker startup and sign-in need neither a gateway
installation nor root workspace resources.

Then review/install the gateway's accounts-broker/system bindings. Review Code
service setup to bind `omp` to that exact gateway installation. Finally,
review/install the root's service/system/location bindings and approve its
bounded native invocation edges. Accounts, gateway and root have separate native
installations: promoting workspace or gateway bindings does not replace the
running broker/sign-in installation. Code's resource promotion adopts these
exact pins; it does not install or grant consent. Service setup uses existing
owner-held credential references and never creates a provisioning daemon.
`prepareWorkspace` creates the declared new workspace/session locations and
runs the pinned OMP version probe as a native job; repeated launches use
separately consented write access. Preparation never replaces existing locations
or clones a repository.

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
