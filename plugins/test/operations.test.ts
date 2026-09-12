import { describe, expect, test } from "bun:test";
import { InstanceServiceDescriptionSchema, MachineHalfSchema, PluginRosterEntrySchema, ServiceConfigurationSchema,
  PublicJobSchema, ServiceReplySchema, formatManifoldUri, type Cap, type JobDescription, type ManifoldRef,
  type ServiceConfiguration, type ServicePolicy } from "@manifold/protocol";
import { actionDoor, actionSchemas, observePermissionPlan, ACCOUNTS_PLUGIN_ID, CODE_PLUGIN_ID, GATEWAY_OPERATION_ID, GATEWAY_PLUGIN_ID,
  type ActionInput, type ActionResult, type CodeAction, type Configuration, type Target } from "../atyrode.code/contract.ts";
import { BROKER_OPERATION_ID, BROKER_SERVICE_ID, SIGN_IN_OPERATION_ID } from "../atyrode.code/auth-contract.ts";
import { digestOf, type CodeContext } from "../atyrode.code/machine-server.ts";
import { handlers } from "../atyrode.code/server.ts";
import { handlers as accountHandlers } from "../atyrode.code/accounts/server.ts";
import type { CatalogDocument } from "../domain/contracts.ts";
import type { ProjectedBrokerSnapshot } from "../domain/accounts.ts";
import { buildCodeServices } from "../atyrode.code/service-policies.ts";
import codeManifest from "../atyrode.code/manifest.json";

const target: Target = { containerId: "container-a", machineId: "machine-a" };
const workspace = { containerId: target.containerId };
const now = Date.UTC(2026, 0, 1, 12);
const unavailable = async (): Promise<never> => { throw new Error("Unexpected native operation"); };

function document(): CatalogDocument {
  return { schemaVersion: 1, models: ([1, 2, 3] as const).map(tier => ({
    key: `model-${tier}`, provider: "anthropic", id: `native-model-${tier}`, api: "anthropic-messages", tier,
    quotaBucket: null, inputCostPerMillion: tier, outputCostPerMillion: tier * 3,
    tokensPerSecond: 30, timeToFirstTokenMs: 100, contextWindow: 200_000,
    thinkingLevels: ["minimal", "low", "medium", "high", "xhigh", "max"], images: true,
  })) };
}

interface Fixture {
  ctx: CodeContext;
  access: { isRoot: boolean; containerScope: string | null; readable: Set<string>; writable: Set<string> };
  resources: { product: string; artifact: string; binding: string; installation: string; brokerRevision: string; brokerOwner: string; policy: string };
  metadata: ProjectedBrokerSnapshot;
  holdTwoReads(): void;
  duringMetadata(hook: () => Promise<void>): void;
}

function fixture(isRoot = false): Fixture {
  const store = new Map<string, string>();
  const access = { isRoot, containerScope: null as string | null, readable: new Set(["container-a", "container-b"]), writable: new Set(["container-a", "container-b"]) };
  const resources = { product: "a".repeat(64), artifact: "b".repeat(64), binding: "c".repeat(64), installation: "install-1",
    brokerRevision: "broker-1", brokerOwner: "broker-owner", policy: "d".repeat(64) };
  const metadata: ProjectedBrokerSnapshot = { credentials: [
    { id: 1, provider: "anthropic", identityKey: "email:alice@example.test|org:original", credential: { type: "oauth" } },
    { id: 2, provider: "anthropic", identityKey: null, credential: { type: "api_key" } },
    { id: 3, provider: "anthropic", identityKey: null, credential: { type: "api_key" } },
  ] };
  let reads: { remaining: number; ready: Promise<void>; release: () => void } | undefined;
  let onMetadata: (() => Promise<void>) | undefined;
  const ctx: CodeContext = {
    now: () => now,
    newId: unavailable,
    emit() {},
    outsideScope: async containerId => access.containerScope !== null && access.containerScope !== containerId ? { refused: "outside_scope" } : null,
    auth: {
      principal: { id: "writer", kind: "human", name: "Writer", color: "#123456" },
      caps: ["containers:read", "containers:write", "machines:run", "services:read", "services:invoke", "terminals:spawn"],
      containerScope: null, get isRoot() { return access.isRoot; },
      allows: async (cap, node) => node?.kind === "container" &&
        ((cap === "containers:read" && access.readable.has(node.containerId)) ||
          (cap === "containers:write" && access.writable.has(node.containerId))),
    },
    storage: {
      pluginId: CODE_PLUGIN_ID,
      get: async key => {
        const value = store.get(key) ?? null;
        const barrier = reads;
        if (barrier) {
          if (--barrier.remaining === 0) { reads = undefined; barrier.release(); }
          await barrier.ready;
        }
        return value;
      },
      set: unavailable, delete: unavailable, keys: async () => [...store.keys()],
      compareAndSet: async (key, expected, value) => {
        if ((store.get(key) ?? null) !== expected) return false;
        store.set(key, value);
        return true;
      },
    },
    host: {
      enabled: async () => true,
      roster: async () => [PluginRosterEntrySchema.parse({
        manifest: { id: CODE_PLUGIN_ID, title: "Code", version: "1.0.0", description: "Offline native action fixture", capabilities: [], contributes: {} },
        enabled: true, source: "plugin", actions: [],
        install: { sha256: resources.product, source: "offline-fixture", installedBy: "owner", installedAt: now, grantedCaps: [] },
      })],
    },
    jobs: {
      describe: async ({ machineId, pluginId }) => {
        if (pluginId !== CODE_PLUGIN_ID) return unavailable();
        return { machineId, pluginId, connected: true, platforms: ["linux-x64"],
          admissionPublicKey: "-----BEGIN PUBLIC KEY-----offline-fixture",
          installation: { revision: resources.installation, artifactSha256: resources.artifact, enabled: true, ready: true, purgeRequested: false },
          retainedInstallations: [], consents: [],
          operations: { [`${CODE_PLUGIN_ID}.launch`]: { ready: true, reason: null, resourceBindingDigest: resources.binding } },
        };
      },
      describeDeployment: unavailable, execute: unavailable, status: unavailable, listRuns: unavailable, input: unavailable,
      cancel: unavailable, output: unavailable, follow: unavailable,
    },
    services: {
      describe: async ({ machineId }) => ({ machineId, connected: true, services: [{
        serviceId: BROKER_SERVICE_ID, revision: "broker-policy-1", policySha256: resources.policy,
        operations: [{ operationId: "metadata", readable: true, invocable: false, ready: true, reason: null }],
      }] }),
      describeInstance: async () => InstanceServiceDescriptionSchema.parse({
        serviceId: BROKER_SERVICE_ID, defaultOwner: { machineId: "local-master", name: "Local master", online: true },
        owner: { machineId: resources.brokerOwner, name: "Broker owner", online: true },
        configuration: { revision: resources.brokerRevision, pluginId: ACCOUNTS_PLUGIN_ID, enabled: true, policySha256: resources.policy },
        connected: true, state: "ready", reason: null,
      }),
      readInstance: async args => {
        if (args.operationId !== "metadata" || args.serviceId !== BROKER_SERVICE_ID || args.expectedRevision !== resources.brokerRevision) return unavailable();
        const hook = onMetadata;
        onMetadata = undefined;
        await hook?.();
        return ServiceReplySchema.parse({ type: "service_result", requestId: "metadata-read", ok: true, result: structuredClone(metadata) });
      },
      read: unavailable, invoke: unavailable, readConfiguration: unavailable, configureConfiguration: unavailable,
      listInstances: unavailable, readInstanceConfiguration: unavailable, configureInstance: unavailable, invokeInstance: unavailable,
    },
  };
  return { ctx, access, resources, metadata,
    holdTwoReads() {
      let release!: () => void;
      const ready = new Promise<void>(resolve => { release = resolve; });
      reads = { remaining: 2, ready, release };
    },
    duringMetadata(hook: () => Promise<void>) { onMetadata = hook; },
  };
}

const actionHandlers = Object.fromEntries([
  ...Object.entries(handlers).map(([name, handler]) => [`${CODE_PLUGIN_ID}.${name}`, handler]),
  ...Object.entries(accountHandlers).map(([name, handler]) => [`${ACCOUNTS_PLUGIN_ID}.${name}`, handler]),
]) as Record<string, (ctx: CodeContext, input: unknown) => Promise<unknown>>;
async function invoke<K extends CodeAction>(f: Fixture, name: K, input: ActionInput<K>): Promise<unknown> {
  const handler = actionHandlers[actionDoor(name)]!;
  return handler(f.ctx, input);
}
async function accepted<K extends CodeAction>(f: Fixture, name: K, input: ActionInput<K>): Promise<ActionResult<K>> {
  return actionSchemas[name].result.parse(await invoke(f, name, input)) as ActionResult<K>;
}
async function initialize(f: Fixture, scope = target) {
  return accepted(f, "initializeConfiguration", { containerId: scope.containerId, expectedRevision: 0 });
}
async function staged(f: Fixture, catalog = document()) {
  await initialize(f);
  return accepted(f, "stageCatalog", { ...workspace, expectedRevision: 1, document: catalog });
}
async function active(f: Fixture) {
  const record = await staged(f);
  const review = await accepted(f, "reviewCatalog", { ...target, expectedRevision: record.revision, source: "draft" });
  return accepted(f, "promoteCatalog", { ...target, expectedRevision: record.revision, source: "draft", reviewDigest: review.reviewDigest });
}
async function configuration(f: Fixture, scope = target) {
  return (await accepted(f, "readConfiguration", { containerId: scope.containerId })).configuration;
}

async function seedLegacy(f: Fixture, scope: Target, record: Configuration) {
  const { resourcesByMachine, ...shared } = record;
  const key = `configuration/${digestOf(scope)}`;
  const raw = JSON.stringify({ ...shared, ...scope, schemaVersion: 1, resources: resourcesByMachine[scope.machineId] ?? null });
  expect(await f.ctx.storage.compareAndSet(key, null, raw)).toBe(true);
  return { key, raw };
}

const resourceChanges: [string, (f: Fixture) => void][] = [
  ["product bytes", f => { f.resources.product = "e".repeat(64); }],
  ["worker bytes", f => { f.resources.artifact = "e".repeat(64); }],
  ["operation binding", f => { f.resources.binding = "e".repeat(64); }],
  ["installation revision", f => { f.resources.installation = "install-2"; }],
  ["service policy", f => { f.resources.policy = "e".repeat(64); }],
  ["broker revision", f => { f.resources.brokerRevision = "broker-2"; }],
  ["broker relocation", f => { f.resources.brokerOwner = "replacement-owner"; f.resources.brokerRevision = "broker-2"; }],
];

describe("headless contextual permission planning", () => {
  const request: ActionInput<"readPermissionPlan"> = { ...target, intent: "setup", choices: [], requestId: "permission-review" };

  test("independent choices form exact operations without provisioning or changing saved configuration", async () => {
    const f = signInFixture();
    const record = await initialize(f);
    const approved = structuredClone(f.accountResources.consents);
    const empty = await accepted(f, "readPermissionPlan", request);
    expect(empty.steps).toEqual([]);
    const selected = await accepted(f, "readPermissionPlan", { ...request, choices: ["discovery", "workspace-existing"] });
    expect(selected.steps.map(step => ({ pluginId: step.request.pluginId, targets: step.request.targets, operations: step.request.operationIds }))).toEqual([{
      pluginId: CODE_PLUGIN_ID, targets: [{ machineId: target.machineId }],
      operations: [`${CODE_PLUGIN_ID}.validate-workspace`, `${CODE_PLUGIN_ID}.catalog-inventory`],
    }]);
    expect(selected.steps[0]?.nativeReady).toBe(false);
    const declined = await accepted(f, "readPermissionPlan", { ...request, choices: [] });
    expect(declined.steps).toEqual([]);
    expect(await configuration(f)).toEqual(record);
    expect(f.accountResources.consents).toEqual(approved);
    expect(f.state.writes).toBe(0);
  });

  test("shared sign-in pins the declared owner, while destination changes invalidate the contextual scope", async () => {
    const f = signInFixture(false);
    const first = await accepted(f, "readPermissionPlan", { ...request, intent: "accounts", choices: null });
    expect(first.ownerApprovalRequired).toBe(true);
    expect(first.steps.map(step => step.request.targets)).toEqual([[{ machineId: f.state.owner.machineId }]]);
    expect(first.steps[0]?.request.operationIds).toEqual([BROKER_OPERATION_ID, SIGN_IN_OPERATION_ID]);
    f.state.owner = { machineId: "new-owner", name: "New owner", online: false };
    const changed = await accepted(f, "readPermissionPlan", { ...request, intent: "accounts", choices: null });
    expect(changed.scopeDigest).not.toBe(first.scopeDigest);
    expect(changed.steps[0]?.request.targets).toEqual([{ machineId: "new-owner" }]);
    expect(changed.steps[0]?.nativeReady).toBeNull();
    expect(f.state.writes).toBe(0);
    f.access.containerScope = "container-b";
    expect(await invoke(f, "readPermissionPlan", request)).toEqual({ refused: "code_scope_refused" });
  });

  test("configuration readiness compares only the chosen destination's promoted resources", async () => {
    const f = fixture();
    f.ctx.jobs.describeDeployment = async () => ({ installation: null, deployment: null });
    const record = await active(f);
    const other = { ...target, machineId: "machine-b" };
    const plan = (machineId: string) => accepted(f, "readPermissionPlan", { ...request, machineId, choices: ["session"] });
    expect((await plan(target.machineId)).steps[0]?.configurationCurrent).toBe(true);
    expect((await plan(other.machineId)).steps[0]?.configurationCurrent).toBe(false);
    const review = await accepted(f, "reviewResources", { ...other, expectedRevision: record.revision });
    await accepted(f, "promoteResources", { ...other, expectedRevision: record.revision, reviewDigest: review.reviewDigest });
    expect((await plan(other.machineId)).steps[0]?.configurationCurrent).toBe(true);
    expect((await plan(target.machineId)).steps[0]?.configurationCurrent).toBe(true);
  });

  test("a ready running account broker needs no retained deployment receipt or new deployment", async () => {
    const f = signInFixture();
    await accepted(f, "prepareSignIn", { containerId: target.containerId, expectedBrokerRevision: null });
    const revision = f.state.revision;
    const policy = structuredClone(f.state.policy);
    const input = { ...request, machineId: null, intent: "accounts" as const, choices: ["accounts" as const] };
    const root = await accepted(f, "readPermissionPlan", input);
    expect(root.steps[0]?.nativeReady).toBeNull();
    const describe = f.ctx.jobs.describe;
    const call = async <K extends "readPermissionPlan" | "readAccountSetup">(name: K, args: ActionInput<K>): Promise<ActionResult<K>> => {
      const door = actionDoor(name);
      // Native jobs descriptions belong to the action's plugin, just as at dispatch.
      const pluginId = door.startsWith(`${ACCOUNTS_PLUGIN_ID}.`) ? ACCOUNTS_PLUGIN_ID : CODE_PLUGIN_ID;
      const ctx = { ...f.ctx, jobs: { ...f.ctx.jobs, describe: async (input: Parameters<typeof describe>[0]) => {
        if (input.pluginId !== pluginId) throw new Error("job_owner_mismatch");
        return describe(input);
      } } };
      const handler = actionHandlers[door];
      if (!handler) throw new Error("No native deployment receipt exists; a running broker would block deployment");
      return actionSchemas[name].result.parse(await handler(ctx, args)) as ActionResult<K>;
    };
    const plan = await observePermissionPlan(call, input);
    expect(plan.blockers).toEqual([]);
    expect(plan.steps).toMatchObject([{ nativeReady: true, configurationCurrent: true,
      featureIds: ["accounts"], request: { targets: [{ machineId: f.state.owner.machineId }] } }]);
    expect(await accepted(f, "readAccountSetup", {})).toMatchObject({ revision, state: "ready", nativeReady: true, canSignIn: true });
    expect(f.state.policy).toEqual(policy);
    expect(f.state.writes).toBe(1);
  });

  test("account setup reports the current owner's missing sign-in grant without redeploying its ready broker", async () => {
    const f = signInFixture();
    await accepted(f, "prepareSignIn", { containerId: target.containerId, expectedBrokerRevision: null });
    const allows = f.ctx.auth.allows;
    f.ctx.auth.allows = async (cap, ref) => !(cap === "network:host" && ref?.kind === "operation" &&
      ref.operationId === SIGN_IN_OPERATION_ID) && await allows(cap, ref);
    const setup = await accepted(f, "readAccountSetup", {});
    expect(setup).toMatchObject({ state: "ready", nativeReady: false, canSignIn: false, canUpdateRuntime: false });
    expect(setup.callerRefusal).toContain("network:host");
    expect(setup.callerRefusal).toContain(formatManifoldUri({ kind: "operation", machineId: f.state.owner.machineId, operationId: SIGN_IN_OPERATION_ID }));
    expect(f.state.writes).toBe(1);
  });

  async function readyWriter() {
    const f = fixture();
    const machine = MachineHalfSchema.parse(codeManifest.machine);
    const roster = f.ctx.host.roster;
    f.ctx.host.roster = async () => (await roster()).map(row => ({ ...row, manifest: { ...row.manifest, machine } }));
    f.ctx.jobs.describeDeployment = async () => ({ installation: {
      revision: f.resources.installation, artifactSha256: f.resources.artifact, machine,
    }, deployment: null });
    const key = (cap: Cap, ref: ManifoldRef) => `${cap} ${formatManifoldUri(ref)}`;
    const grants = new Set<string>();
    const consents: JobDescription["consents"] = [];
    const allow = (cap: Exclude<Cap, "*">, ref: ManifoldRef, consent = false) => {
      grants.add(key(cap, ref));
      if (!f.ctx.auth.caps.includes(cap)) (f.ctx.auth.caps as Cap[]).push(cap);
      if (consent) consents.push({ cap, node: formatManifoldUri(ref), enabled: true, revision: "owner-consent" });
    };
    for (const [operation, caps] of Object.entries({
      "catalog-inventory": ["machines:run", "network:host", "jobs:read"],
      "catalog-benchmark": ["machines:run", "network:host", "jobs:read"],
      "prepare-workspace": ["machines:run", "jobs:read"],
      "validate-workspace": ["machines:run", "jobs:read"],
      launch: ["machines:run", "network:host"],
    } as const)) for (const cap of caps)
      allow(cap, { kind: "operation", machineId: target.machineId, operationId: `${CODE_PLUGIN_ID}.${operation}` }, true);
    for (const locationId of [`${CODE_PLUGIN_ID}.workspace`, `${CODE_PLUGIN_ID}.sessions`])
      for (const cap of ["locations:read", "locations:write", "locations:create"] as const)
        allow(cap, { kind: "location", machineId: target.machineId, locationId }, true);
    for (const operationId of ["models", "stream"])
      allow("services:invoke", { kind: "service", machineId: target.machineId, serviceId: "omp", operationId });
    allow("terminals:spawn", { kind: "container", containerId: target.containerId });
    allow("machines:run", { kind: "machine", machineId: target.machineId });
    const allows = f.ctx.auth.allows;
    f.ctx.auth.allows = async (cap, ref) => ref !== undefined && (grants.has(key(cap, ref)) || await allows(cap, ref));
    const describe = f.ctx.jobs.describe;
    f.ctx.jobs.describe = async input => ({ ...await describe(input), consents,
      operations: Object.fromEntries(Object.keys(machine.operations).map(operationId => [operationId,
        { ready: true, reason: null, resourceBindingDigest: f.resources.binding }])) });
    const services = f.ctx.services.describe;
    f.ctx.services.describe = async input => {
      const description = await services(input);
      return { ...description, services: [...description.services, {
        serviceId: "omp", revision: "1", policySha256: f.resources.policy,
        operations: ["models", "stream"].map(operationId => ({ operationId, readable: true, invocable: true, ready: true, reason: null })),
      }] };
    };
    await active(f);
    return { f, grants, key, consents };
  }

  test("another identity's installed consents cannot make a writer without network authority ready", async () => {
    const { f, grants, key, consents } = await readyWriter();
    const input = { ...request, choices: ["discovery" as const] };
    expect((await accepted(f, "readPermissionPlan", input)).steps[0]?.nativeReady).toBe(true);
    const denied = { kind: "operation" as const, machineId: target.machineId, operationId: `${CODE_PLUGIN_ID}.catalog-inventory` };
    grants.delete(key("network:host", denied));
    const plan = await accepted(f, "readPermissionPlan", input);
    expect(plan.steps[0]).toMatchObject({ nativeReady: false, configurationCurrent: true });
    expect(plan.blockers[0]).toContain("network:host");
    expect(plan.blockers[0]).toContain(formatManifoldUri(denied));
    expect(consents.find(consent => consent.cap === "network:host" && consent.node === formatManifoldUri(denied))?.enabled).toBe(true);
    const independent = await accepted(f, "readPermissionPlan", { ...request, choices: ["workspace-existing"] });
    expect(independent.steps[0]).toMatchObject({ nativeReady: true, featureIds: ["workspace-existing"] });
    expect(independent.blockers).toEqual([]);
    expect(independent.ownerApprovalRequired).toBe(false);
  });

  test("readiness follows each consumer's exact location, output and terminal-placement authority", async () => {
    const { f, grants, key } = await readyWriter();
    const cases = [
      { feature: "workspace-existing", cap: "locations:read", ref: { kind: "location", machineId: target.machineId, locationId: `${CODE_PLUGIN_ID}.sessions` } },
      { feature: "workspace-create", cap: "locations:create", ref: { kind: "location", machineId: target.machineId, locationId: `${CODE_PLUGIN_ID}.workspace` } },
      { feature: "session", cap: "locations:write", ref: { kind: "location", machineId: target.machineId, locationId: `${CODE_PLUGIN_ID}.sessions` } },
      { feature: "discovery", cap: "jobs:read", ref: { kind: "operation", machineId: target.machineId, operationId: `${CODE_PLUGIN_ID}.catalog-inventory` } },
      { feature: "session", cap: "terminals:spawn", ref: { kind: "container", containerId: target.containerId } },
      { feature: "session", cap: "services:invoke", ref: { kind: "service", machineId: target.machineId, serviceId: "omp", operationId: "stream" } },
    ] as const;
    for (const { feature, cap, ref } of cases) {
      const input = { ...request, choices: [feature] };
      expect((await accepted(f, "readPermissionPlan", input)).steps[0]?.nativeReady).toBe(true);
      grants.delete(key(cap, ref));
      const denied = await accepted(f, "readPermissionPlan", input);
      expect(denied.steps[0]?.nativeReady).toBe(false);
      expect(denied.blockers.some(reason => reason.includes(cap) && reason.includes(formatManifoldUri(ref)))).toBe(true);
      grants.add(key(cap, ref));
      expect((await accepted(f, "readPermissionPlan", input)).steps[0]?.nativeReady).toBe(true);
    }
    grants.delete(key("jobs:read", { kind: "operation", machineId: target.machineId, operationId: `${CODE_PLUGIN_ID}.catalog-inventory` }));
    expect((await accepted(f, "readPermissionPlan", { ...request, choices: ["session"] })).steps[0]?.nativeReady).toBe(true);
  });
});

describe("canonical typed Code actions", () => {
  test("competing same-revision writers commit once and a stale retry cannot overwrite the winner", async () => {
    const f = fixture();
    await initialize(f);
    f.holdTwoReads();
    const results = await Promise.all(["first", "second"].map(id => invoke(f, "changeAccounts", {
      ...workspace, expectedRevision: 1, change: { kind: "create-preset", preset: { id, name: id, disabled: [] } },
    })));
    expect(results.filter(result => actionSchemas.changeAccounts.result.safeParse(result).success)).toHaveLength(1);
    expect(results.filter(result => !actionSchemas.changeAccounts.result.safeParse(result).success)).toEqual([{ refused: "code_stale_preferences" }]);
    const winner = await configuration(f);
    expect(winner?.revision).toBe(2);
    expect(winner?.accounts.presets).toHaveLength(1);
    const loser = winner!.accounts.presets[0]!.id === "first" ? "second" : "first";
    expect(await invoke(f, "changeAccounts", { ...workspace, expectedRevision: 1,
      change: { kind: "create-preset", preset: { id: loser, name: loser, disabled: [] } },
    })).toEqual({ refused: "code_stale_preferences" });
    expect(await configuration(f)).toEqual(winner);
  });

  test("destinations share a container profile and revision while distinct containers stay isolated", async () => {
    const f = fixture();
    const first = await active(f);
    const other = { ...target, machineId: "machine-b" };
    const isolated = await initialize(f, { ...target, containerId: "container-b" });
    const selected = await accepted(f, "select", { ...workspace, expectedRevision: first.revision,
      selection: { ...first.selection!, planYolo: true } });
    const changed = await accepted(f, "changeAccounts", { ...workspace, expectedRevision: selected.revision,
      change: { kind: "create-preset", preset: { id: "shared", name: "Shared", disabled: [] } } });
    for (const destination of [target, other]) {
      const read = await accepted(f, "readConfiguration", { ...workspace, legacyMachineId: destination.machineId });
      expect(read).toEqual({ revision: changed.revision, configuration: changed, legacyMachineId: null });
      expect((await accepted(f, "reviewCatalog", { ...destination, expectedRevision: read.revision, source: "active" })).review.selection.planYolo).toBe(true);
    }
    expect(changed.accounts.presets.map(preset => preset.id)).toEqual(["shared"]);
    expect(await configuration(f, { ...target, containerId: "container-b" })).toEqual(isolated);
    expect(changed).not.toHaveProperty("machineId");
    expect(changed).not.toHaveProperty("resources");
  });

  test("resource promotions from different destinations compete in one container CAS", async () => {
    const f = fixture();
    const initial = await initialize(f);
    const destinations = [target, { ...target, machineId: "machine-b" }];
    const reviews = await Promise.all(destinations.map(destination => accepted(f, "reviewResources", { ...destination, expectedRevision: initial.revision })));
    f.holdTwoReads();
    const results = await Promise.all(destinations.map((destination, index) => invoke(f, "promoteResources", {
      ...destination, expectedRevision: initial.revision, reviewDigest: reviews[index]!.reviewDigest,
    })));
    const winnerIndex = results.findIndex(result => actionSchemas.promoteResources.result.safeParse(result).success);
    expect(winnerIndex).not.toBe(-1);
    expect(results[1 - winnerIndex]).toEqual({ refused: "code_stale_preferences" });
    const saved = await configuration(f);
    expect(saved?.revision).toBe(initial.revision + 1);
    expect(saved?.resourcesByMachine).toEqual({ [destinations[winnerIndex]!.machineId]: reviews[winnerIndex]!.resources });
    expect(await invoke(f, "promoteResources", { ...destinations[1 - winnerIndex]!, expectedRevision: initial.revision,
      reviewDigest: reviews[1 - winnerIndex]!.reviewDigest })).toEqual({ refused: "code_stale_preferences" });
    expect(await configuration(f)).toEqual(saved);
  });

  test("legacy adoption reads only the selected destination and preserves the original recovery records", async () => {
    const source = fixture();
    const original = await active(source);
    const account = (await accepted(source, "accounts", {})).accounts[0]!.reference;
    const selected = await accepted(source, "select", { ...workspace, expectedRevision: original.revision,
      selection: { ...original.selection!, planYolo: true } });
    const choices = await accepted(source, "changeAccounts", { ...workspace, expectedRevision: selected.revision,
      change: { kind: "set-account", reference: account, enabled: false } });
    const legacy = await accepted(source, "stageCatalog", { ...workspace, expectedRevision: choices.revision, document: document() });
    const f = fixture();
    const a = await seedLegacy(f, target, legacy);
    const other = { ...target, machineId: "machine-b" };
    const b = await seedLegacy(f, other, { ...original, revision: legacy.revision + 10, updatedAt: now + 10_000 });
    expect(await accepted(f, "readConfiguration", workspace)).toEqual({ revision: 0, configuration: null, legacyMachineId: null });
    expect(await accepted(f, "readConfiguration", { ...workspace, legacyMachineId: "missing" }))
      .toEqual({ revision: 0, configuration: null, legacyMachineId: null });
    const lookup = { ...workspace, legacyMachineId: target.machineId };
    const read = await accepted(f, "readConfiguration", lookup);
    expect(read).toEqual({ revision: legacy.revision, configuration: legacy, legacyMachineId: target.machineId });
    expect(await configuration(f)).toBeNull();
    expect(await invoke(f, "select", { ...workspace, expectedRevision: legacy.revision, selection: legacy.selection! }))
      .toEqual({ refused: "code_stale_preferences" });
    const adopted = await accepted(f, "initializeConfiguration", { ...lookup, expectedRevision: read.revision });
    expect(adopted).toEqual({ ...legacy, revision: legacy.revision + 1 });
    expect(await accepted(f, "readConfiguration", { ...workspace, legacyMachineId: other.machineId }))
      .toEqual({ revision: adopted.revision, configuration: adopted, legacyMachineId: null });
    expect(await invoke(f, "initializeConfiguration", { ...workspace, legacyMachineId: other.machineId, expectedRevision: adopted.revision }))
      .toEqual({ refused: "code_stale_preferences" });
    expect(await f.ctx.storage.get(a.key)).toBe(a.raw);
    expect(await f.ctx.storage.get(b.key)).toBe(b.raw);
    expect(await invoke(f, "previewLaunch", { ...other, expectedRevision: adopted.revision })).toEqual({ refused: "code_resources_changed" });
  });

  test("concurrent first writers create one canonical record without consulting other legacy destinations", async () => {
    const f = fixture();
    const original = await active(fixture());
    const legacy = await seedLegacy(f, { ...target, machineId: "machine-b" }, original);
    f.holdTwoReads();
    const results = await Promise.all([undefined, "missing"].map(legacyMachineId => invoke(f, "initializeConfiguration", {
      ...workspace, legacyMachineId, expectedRevision: 0,
    })));
    expect(results.filter(result => actionSchemas.initializeConfiguration.result.safeParse(result).success)).toHaveLength(1);
    expect(results.filter(result => !actionSchemas.initializeConfiguration.result.safeParse(result).success)).toEqual([{ refused: "code_stale_preferences" }]);
    expect(await configuration(f)).toMatchObject({ revision: 1, active: null, draft: null, resourcesByMachine: {} });
    expect(await f.ctx.storage.get(legacy.key)).toBe(legacy.raw);
  });

  test("concurrent explicit legacy adopters cannot overwrite or merge the canonical winner", async () => {
    const f = fixture();
    const original = await active(fixture());
    const other = { ...target, machineId: "machine-b" };
    const alternate = { ...original, selection: { ...original.selection!, planYolo: !original.selection!.planYolo },
      resourcesByMachine: { [other.machineId]: original.resourcesByMachine[target.machineId]! } };
    const records = [original, alternate], destinations = [target, other];
    const legacy = await Promise.all(destinations.map((destination, index) => seedLegacy(f, destination, records[index]!)));
    f.holdTwoReads();
    const results = await Promise.all(destinations.map(destination => invoke(f, "initializeConfiguration", {
      ...workspace, legacyMachineId: destination.machineId, expectedRevision: original.revision,
    })));
    const winnerIndex = results.findIndex(result => actionSchemas.initializeConfiguration.result.safeParse(result).success);
    expect(winnerIndex).not.toBe(-1);
    expect(results[1 - winnerIndex]).toEqual({ refused: "code_stale_preferences" });
    expect(await configuration(f)).toEqual({ ...records[winnerIndex]!, revision: original.revision + 1 });
    for (const saved of legacy) expect(await f.ctx.storage.get(saved.key)).toBe(saved.raw);
  });

  test("read-only authority can read its container but cannot mutate it or disclose a different container", async () => {
    const f = fixture();
    const original = await initialize(f);
    await initialize(f, { ...target, containerId: "container-b" });
    f.access.writable.clear();
    f.access.readable.delete("container-b");
    expect(await configuration(f)).toEqual(original);
    expect(await invoke(f, "changeAccounts", { ...workspace, expectedRevision: 1,
      change: { kind: "create-preset", preset: { id: "forbidden", name: "Forbidden", disabled: [] } },
    })).toEqual({ refused: "code_scope_refused" });
    expect(await invoke(f, "readConfiguration", { containerId: "container-b" })).toEqual({ refused: "code_scope_refused" });
    expect(await configuration(f)).toEqual(original);
    f.access.readable.add("container-b");
    f.access.writable.add("container-b");
    f.access.containerScope = "container-a";
    const foreign = { containerId: "container-b" };
    expect(await invoke(f, "readConfiguration", foreign)).toEqual({ refused: "code_scope_refused" });
    expect(await invoke(f, "stageCatalog", { ...foreign, expectedRevision: 1, document: document() })).toEqual({ refused: "code_scope_refused" });
    f.access.containerScope = null;
    expect(await accepted(f, "readConfiguration", foreign)).toMatchObject({ revision: 1, configuration: { draft: null } });
  });

  test("catalog promotion binds exact catalog bytes even when routes, target and revision match", async () => {
    const first = fixture(), second = fixture();
    await staged(first);
    const changed = document();
    changed.models[0]!.contextWindow = 199_999;
    await staged(second, changed);
    const review = await accepted(first, "reviewCatalog", { ...target, expectedRevision: 2, source: "draft" });
    const other = await accepted(second, "reviewCatalog", { ...target, expectedRevision: 2, source: "draft" });
    expect(other.review.routes).toEqual(review.review.routes);
    expect(other.review.selection).toEqual(review.review.selection);
    expect(await invoke(second, "promoteCatalog", { ...target, expectedRevision: 2, source: "draft", reviewDigest: review.reviewDigest })).toEqual({ refused: "code_preview_changed" });
    expect(await configuration(second)).toMatchObject({ revision: 2, active: null, draft: { document: changed } });
    const promoted = await accepted(second, "promoteCatalog", { ...target, expectedRevision: 2, source: "draft", reviewDigest: other.reviewDigest });
    expect(promoted.active?.document).toEqual(changed);
    expect(promoted.draft).toBeNull();
  });

  test("catalog and resource reviews cannot authorize a different destination with identical native pins", async () => {
    const f = fixture();
    const record = await staged(f);
    const other = { ...target, machineId: "machine-b" };
    const catalog = await accepted(f, "reviewCatalog", { ...target, expectedRevision: record.revision, source: "draft" });
    const resources = await accepted(f, "reviewResources", { ...target, expectedRevision: record.revision });
    expect(await invoke(f, "promoteCatalog", { ...other, expectedRevision: record.revision, source: "draft", reviewDigest: catalog.reviewDigest }))
      .toEqual({ refused: "code_preview_changed" });
    expect(await invoke(f, "promoteResources", { ...other, expectedRevision: record.revision, reviewDigest: resources.reviewDigest }))
      .toEqual({ refused: "code_preview_changed" });
    expect(await configuration(f)).toEqual(record);
  });

  for (const [name, change] of resourceChanges) {
    test(`catalog and resource promotion refuse changed ${name}`, async () => {
      const f = fixture();
      await staged(f);
      const catalog = await accepted(f, "reviewCatalog", { ...target, expectedRevision: 2, source: "draft" });
      const resources = await accepted(f, "reviewResources", { ...target, expectedRevision: 2 });
      change(f);
      expect(await invoke(f, "promoteCatalog", { ...target, expectedRevision: 2, source: "draft", reviewDigest: catalog.reviewDigest })).toEqual({ refused: "code_preview_changed" });
      expect(await invoke(f, "promoteResources", { ...target, expectedRevision: 2, reviewDigest: resources.reviewDigest })).toEqual({ refused: "code_preview_changed" });
      expect(await configuration(f)).toMatchObject({ revision: 2, active: null, resourcesByMachine: {} });
    });
  }
});

describe("confirmed credential mutations", () => {
  for (const action of ["clearAccountBlocks", "disableCredential"] as const) {
    test(`${action} refuses a renewed OAuth slot until that exact slot is confirmed`, async () => {
      const f = fixture();
      f.metadata.credentials[0]!.blocks = [{ blockScope: "provider", blockedUntilMs: now + 60_000 }];
      const reviewed = (await accepted(f, "accounts", {})).accounts.find(account => account.credentialId === 1)!;
      const confirmation = { ...target, reference: reviewed.reference, credentialId: reviewed.credentialId };
      let mutations = 0;
      f.ctx.services.invokeInstance = async args => {
        mutations++;
        if (args.serviceId !== BROKER_SERVICE_ID || args.expectedRevision !== f.resources.brokerRevision) return unavailable();
        const credential = f.metadata.credentials.find(row => String(row.id) === args.input.credentialId);
        if (!credential) return unavailable();
        if (args.operationId === "clear-blocks") credential.blocks = [];
        else if (args.operationId === "disable") credential.disabled = true;
        else return unavailable();
        return ServiceReplySchema.parse({ type: "service_result", requestId: "credential-mutation", ok: true, result: { ok: true } });
      };

      f.metadata.credentials[0]!.id = 4;
      const replacement = (await accepted(f, "accounts", {})).accounts.find(account => account.credentialId === 4)!;
      expect(replacement.reference).toEqual(reviewed.reference);
      expect(await invoke(f, action, confirmation)).toEqual({ refused: "code_account_unavailable" });
      expect(mutations).toBe(0);
      expect((await accepted(f, "accounts", {})).accounts.find(account => account.credentialId === 4)).toEqual(replacement);

      const result = await accepted(f, action, { ...target, reference: replacement.reference, credentialId: replacement.credentialId });
      expect(result.accounts.find(account => account.credentialId === 4)).toEqual({
        ...replacement, ...(action === "clearAccountBlocks" ? { blocks: [] } : { disabled: true }),
      });
      expect(mutations).toBe(1);
    });

    test(`${action} requires a positive safe credential slot`, async () => {
      const f = fixture();
      const account = (await accepted(f, "accounts", {})).accounts[0]!;
      let mutations = 0;
      f.ctx.services.invokeInstance = async () => { mutations++; return unavailable(); };
      for (const credentialId of [undefined, 0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
        expect(await actionHandlers[actionDoor(action)]!(f.ctx, { ...target, reference: account.reference, credentialId }))
          .toEqual({ refused: "code_invalid_request" });
      }
      expect(mutations).toBe(0);
    });
  }
});

describe("exact native launch preview", () => {
  test("A's promoted resources and preview cannot authorize B even with identical native observations", async () => {
    const f = fixture();
    const initial = await active(f);
    const other = { ...target, machineId: "machine-b" };
    const selected = await accepted(f, "select", { ...workspace, expectedRevision: initial.revision,
      selection: { ...initial.selection!, planYolo: true } });
    const original = await accepted(f, "previewLaunch", { ...target, expectedRevision: selected.revision });
    expect(await invoke(f, "previewLaunch", { ...other, expectedRevision: selected.revision })).toEqual({ refused: "code_resources_changed" });
    expect(await invoke(f, "prepareLaunch", { ...other, expectedRevision: selected.revision, previewDigest: original.previewDigest, prompt: "" }))
      .toEqual({ refused: "code_resources_changed" });
    const review = await accepted(f, "reviewResources", { ...other, expectedRevision: selected.revision });
    expect(review.current).toBe(false);
    const promoted = await accepted(f, "promoteResources", { ...other, expectedRevision: selected.revision, reviewDigest: review.reviewDigest });
    const a = await accepted(f, "previewLaunch", { ...target, expectedRevision: promoted.revision });
    const b = await accepted(f, "previewLaunch", { ...other, expectedRevision: promoted.revision });
    expect(a.resources).toEqual(b.resources);
    expect(a.review).toEqual(b.review);
    expect(a.accountPool).toEqual(b.accountPool);
    expect(a.machineId).toBe(target.machineId);
    expect(b.machineId).toBe(other.machineId);
    expect(await invoke(f, "prepareLaunch", { ...other, expectedRevision: promoted.revision, previewDigest: a.previewDigest, prompt: "" }))
      .toEqual({ refused: "code_preview_changed" });
    const prepared = await accepted(f, "prepareLaunch", { ...other, expectedRevision: promoted.revision, previewDigest: b.previewDigest, prompt: "" });
    expect(prepared.runtime.input.planYolo).toBe(true);
    expect((await accepted(f, "reviewResources", { ...target, expectedRevision: promoted.revision })).current).toBe(true);
    expect(await configuration(f)).toEqual(promoted);
  });

  test("a worker launches with shared account choices without executing on the broker owner or enabling disabled slots", async () => {
    const f = fixture();
    const describe = f.ctx.jobs.describe;
    f.ctx.jobs.describe = args => args.machineId === target.machineId ? describe(args) : unavailable();
    f.ctx.services.describe = async ({ machineId }) => ({ machineId, connected: true, services: [] });
    const record = await active(f);
    const accounts = await accepted(f, "accounts", {});
    const disabled = accounts.accounts.find(account => account.credentialId === 2)!.reference;
    const changed = await accepted(f, "changeAccounts", { ...workspace, expectedRevision: record.revision, change: { kind: "set-account", reference: disabled, enabled: false } });
    const preview = await accepted(f, "previewLaunch", { ...target, expectedRevision: changed.revision });
    expect(preview.accountPool).toEqual({ anthropic: [
      { credentialId: 1, identityKey: "email:alice@example.test|org:original" }, { credentialId: 3, identityKey: null },
    ] });
    const result = await accepted(f, "prepareLaunch", { ...target, expectedRevision: changed.revision, previewDigest: preview.previewDigest, prompt: "Review this change" });
    const config = JSON.parse(String(result.runtime.input.config));
    const lead = preview.review.routes.find(route => route.role === "default")!.lead;
    expect(config.modelRoles.default).toBe(`anthropic/native-${lead.key}:${lead.thinking}`);
    expect(await configuration(f)).toEqual(changed);
  });

  const accountChanges: [string, number, (f: Fixture) => void][] = [
    ["OAuth identity after re-login", 1, f => { f.metadata.credentials[0]!.identityKey = "email:alice@example.test|org:new"; }],
    ["API-key slot replacement", 2, f => { f.metadata.credentials[1]!.id = 4; }],
    ["API-key provider change", 2, f => { f.metadata.credentials[1]!.provider = "openai"; }],
    ["native service scope change", 2, f => { f.resources.brokerRevision = "broker-2"; }],
    ["broker owner replacement", 2, f => { f.resources.brokerOwner = "other-owner"; f.resources.brokerRevision = "broker-2"; }],
  ];
  for (const [name, slot, change] of accountChanges) {
    test(`fresh metadata cannot broaden a disabled reference after ${name}`, async () => {
      const f = fixture();
      const record = await active(f);
      const accounts = await accepted(f, "accounts", {});
      const reference = accounts.accounts.find(account => account.credentialId === slot)!.reference;
      let changed = await accepted(f, "changeAccounts", { ...workspace, expectedRevision: record.revision, change: { kind: "set-account", reference, enabled: false } });
      await accepted(f, "previewLaunch", { ...target, expectedRevision: changed.revision });
      change(f);
      // Explicitly accept new resource pins: that must not rebind saved account choices.
      const resources = await accepted(f, "reviewResources", { ...target, expectedRevision: changed.revision });
      changed = await accepted(f, "promoteResources", { ...target, expectedRevision: changed.revision, reviewDigest: resources.reviewDigest });
      expect(await invoke(f, "previewLaunch", { ...target, expectedRevision: changed.revision })).toEqual({ refused: "code_account_unavailable" });
      expect((await configuration(f))?.accounts.manualDisabled).toEqual([reference]);
    });
  }

  test("adding a fresh account invalidates the exact preview rather than silently widening its pool", async () => {
    const f = fixture();
    const record = await active(f);
    const preview = await accepted(f, "previewLaunch", { ...target, expectedRevision: record.revision });
    f.metadata.credentials.push({ id: 4, provider: "anthropic", identityKey: null, credential: { type: "api_key" } });
    expect(await invoke(f, "prepareLaunch", { ...target, expectedRevision: record.revision, previewDigest: preview.previewDigest, prompt: "Run" })).toEqual({ refused: "code_preview_changed" });
    expect(await configuration(f)).toEqual(record);
  });

  for (const [name, change] of resourceChanges) {
    test(`launch refuses a preview after changed ${name}`, async () => {
      const f = fixture();
      const record = await active(f);
      const preview = await accepted(f, "previewLaunch", { ...target, expectedRevision: record.revision });
      change(f);
      expect(await invoke(f, "prepareLaunch", { ...target, expectedRevision: record.revision, previewDigest: preview.previewDigest, prompt: "Run" })).toEqual({ refused: "code_resources_changed" });
    });
  }

  test("selection edits invalidate an older preview at both old and current revisions", async () => {
    const f = fixture();
    const record = await active(f);
    const preview = await accepted(f, "previewLaunch", { ...target, expectedRevision: record.revision });
    const changed = await accepted(f, "select", { ...workspace, expectedRevision: record.revision, selection: { ...record.selection!, planYolo: !record.selection!.planYolo } });
    expect(await invoke(f, "prepareLaunch", { ...target, expectedRevision: record.revision, previewDigest: preview.previewDigest, prompt: "Run" })).toEqual({ refused: "code_stale_preferences" });
    expect(await invoke(f, "prepareLaunch", { ...target, expectedRevision: changed.revision, previewDigest: preview.previewDigest, prompt: "Run" })).toEqual({ refused: "code_preview_changed" });
    expect(await configuration(f)).toEqual(changed);
  });

  for (const action of ["previewLaunch", "prepareLaunch"] as const) {
    test(`${action} refuses preferences committed while broker metadata is being read`, async () => {
      const f = fixture();
      const record = await active(f);
      const preview = await accepted(f, "previewLaunch", { ...target, expectedRevision: record.revision });
      f.duringMetadata(async () => {
        await accepted(f, "select", { ...workspace, expectedRevision: record.revision, selection: { ...record.selection!, planYolo: !record.selection!.planYolo } });
      });
      const input = { ...target, expectedRevision: record.revision, previewDigest: preview.previewDigest, prompt: "Run" };
      expect(await invoke(f, action, action === "previewLaunch" ? { ...target, expectedRevision: record.revision } : input)).toEqual({ refused: "code_stale_preferences" });
      expect((await configuration(f))?.selection?.planYolo).toBe(!record.selection!.planYolo);
    });
  }
});

function workspaceFixture(mode: ActionInput<"prepareWorkspace">["mode"]) {
  const f = fixture();
  const operationId = `${CODE_PLUGIN_ID}.${mode === "create" ? "prepare-workspace" : "validate-workspace"}`;
  const alternateId = `${CODE_PLUGIN_ID}.${mode === "create" ? "validate-workspace" : "prepare-workspace"}`;
  const state = { ready: true, consent: true, attempts: 0 };
  const describe = f.ctx.jobs.describe;
  f.ctx.jobs.describe = async args => {
    const description = await describe(args);
    return { ...description, installation: { ...description.installation!, ready: false }, operations: {
      [operationId]: { ready: state.ready, reason: state.ready ? null : "consent_required", resourceBindingDigest: f.resources.binding },
      [alternateId]: { ready: false, reason: "consent_required", resourceBindingDigest: "f".repeat(64) },
    } };
  };
  f.ctx.newId = async () => "workspace-attempt";
  f.ctx.jobs.execute = async args => {
    state.attempts++;
    if (args.operationId !== operationId || !state.consent) return unavailable();
    return PublicJobSchema.parse({
      jobId: args.jobId, machineId: args.machineId, pluginId: CODE_PLUGIN_ID, operationId,
      installationRevision: args.installationRevision, artifactSha256: args.artifactSha256,
      resourceBindingDigest: args.resourceBindingDigest, inputDigest: digestOf(args.input),
      state: "queued", nextInputSeq: null, result: null,
      authority: { origin: { kind: "action", traceId: "workspace-trace", door: `${CODE_PLUGIN_ID}.prepareWorkspace` },
        requester: "writer", executor: null, decision: null },
    });
  };
  return { ...f, state, operationId };
}

async function promotedWorkspace(f: Fixture) {
  const initial = await initialize(f);
  const review = await accepted(f, "reviewResources", { ...target, expectedRevision: initial.revision });
  return accepted(f, "promoteResources", { ...target, expectedRevision: initial.revision, reviewDigest: review.reviewDigest });
}

describe("explicit native workspace preparation", () => {
  for (const mode of ["create", "existing"] as const) {
    test(`${mode} admits only its selected operation without the alternate consent`, async () => {
      const f = workspaceFixture(mode);
      const record = await promotedWorkspace(f);
      const input = { ...target, expectedRevision: record.revision, mode };
      expect(await accepted(f, "prepareWorkspace", input)).toMatchObject({ operationId: f.operationId, state: "queued" });
      expect(await invoke(f, "prepareWorkspace", { ...input, mode: mode === "create" ? "existing" : "create" }))
        .toEqual({ refused: "code_resources_incomplete" });
      expect(f.state.attempts).toBe(1);
    });

  }
  const mode = "existing" as const;
    test(`${mode} cannot bypass withdrawn native readiness or admission consent`, async () => {
      const f = workspaceFixture(mode);
      const record = await promotedWorkspace(f);
      const input = { ...target, expectedRevision: record.revision, mode };
      f.state.ready = false;
      expect(await invoke(f, "prepareWorkspace", input)).toEqual({ refused: "code_resources_incomplete" });
      expect(f.state.attempts).toBe(0);
      f.state.ready = true;
      f.state.consent = false;
      expect(await invoke(f, "prepareWorkspace", input)).toEqual({ refused: "code_operation_unavailable" });
      expect(f.state.attempts).toBe(1);
    });

    test(`${mode} refuses changed promoted installation, artifact or operation binding before admission`, async () => {
      for (const change of [
        (f: Fixture) => { f.resources.installation = "install-2"; },
        (f: Fixture) => { f.resources.artifact = "e".repeat(64); },
        (f: Fixture) => { f.resources.binding = "e".repeat(64); },
      ]) {
        const f = workspaceFixture(mode);
        const record = await promotedWorkspace(f);
        change(f);
        expect(await invoke(f, "prepareWorkspace", { ...target, expectedRevision: record.revision, mode }))
          .toEqual({ refused: "code_resources_changed" });
        expect(f.state.attempts).toBe(0);
      }
    });


  test("missing or unsupported modes never silently choose a workspace operation", async () => {
    const f = workspaceFixture("existing");
    const record = await promotedWorkspace(f);
    const handler = actionHandlers[actionDoor("prepareWorkspace")]!;
    for (const input of [
      { ...target, expectedRevision: record.revision },
      { ...target, expectedRevision: record.revision, mode: "reuse" },
    ]) expect(await handler(f.ctx, input)).toEqual({ refused: "code_invalid_request" });
    expect(f.state.attempts).toBe(0);
  });

  test("existing validation retains container scope, write authority and revision checks", async () => {
    const f = workspaceFixture("existing");
    const record = await promotedWorkspace(f);
    const input = { ...target, expectedRevision: record.revision, mode: "existing" as const };
    f.access.containerScope = "container-b";
    expect(await invoke(f, "prepareWorkspace", input)).toEqual({ refused: "code_scope_refused" });
    f.access.containerScope = null;
    f.access.writable.clear();
    expect(await invoke(f, "prepareWorkspace", input)).toEqual({ refused: "code_scope_refused" });
    f.access.writable.add(target.containerId);
    expect(await invoke(f, "prepareWorkspace", { ...input, expectedRevision: record.revision - 1 }))
      .toEqual({ refused: "code_stale_preferences" });
    expect(f.state.attempts).toBe(0);
  });

  test("existing validation refuses preferences committed during native resource observation", async () => {
    const f = workspaceFixture("existing");
    const record = await promotedWorkspace(f);
    const describe = f.ctx.jobs.describe;
    let changed = false;
    f.ctx.jobs.describe = async args => {
      if (!changed) {
        changed = true;
        await accepted(f, "changeAccounts", { ...workspace, expectedRevision: record.revision,
          change: { kind: "create-preset", preset: { id: "new", name: "New", disabled: [] } } });
      }
      return describe(args);
    };
    expect(await invoke(f, "prepareWorkspace", { ...target, expectedRevision: record.revision, mode: "existing" }))
      .toEqual({ refused: "code_stale_preferences" });
    expect(f.state.attempts).toBe(0);
  });
});

test("inventory admission refuses account exclusions committed during broker observation", async () => {
  const f = fixture();
  const describe = f.ctx.jobs.describe;
  f.ctx.jobs.describe = async args => {
    const description = await describe(args);
    return { ...description, operations: { ...description.operations,
      [`${CODE_PLUGIN_ID}.catalog-inventory`]: { ready: true, reason: null, resourceBindingDigest: f.resources.binding } } };
  };
  f.ctx.newId = async () => "inventory-attempt";
  let started = 0;
  f.ctx.jobs.execute = async () => { started++; return unavailable(); };
  const record = await active(f);
  const accounts = await accepted(f, "accounts", {});
  const reference = accounts.accounts.find(account => account.credentialId === 1)!.reference;
  f.duringMetadata(async () => {
    await accepted(f, "changeAccounts", { ...workspace, expectedRevision: record.revision,
      change: { kind: "set-account", reference, enabled: false } });
  });
  expect(await invoke(f, "startInventory", { ...target, expectedRevision: record.revision }))
    .toEqual({ refused: "code_stale_preferences" });
  expect(started).toBe(0);
});

test("a worker's inherited broker pin cannot substitute a newer instance registry revision", async () => {
  const f = fixture();
  const record = await active(f);
  const describe = f.ctx.services.describeInstance;
  f.ctx.services.describeInstance = async args => {
    const description = await describe(args);
    return { ...description, configuration: { ...description.configuration!, revision: "replacement-revision" } };
  };
  expect(await invoke(f, "previewLaunch", { ...target, expectedRevision: record.revision }))
    .toEqual({ refused: "code_resources_changed" });
});

test("a missing shared owner never falls back to a worker's available local broker", async () => {
  const f = fixture();
  const record = await active(f);
  const describe = f.ctx.services.describeInstance;
  f.ctx.services.describeInstance = async args => ({ ...await describe(args), owner: null, connected: false, state: "unavailable" });
  expect(await invoke(f, "previewLaunch", { ...target, expectedRevision: record.revision }))
    .toEqual({ refused: "code_broker_unavailable" });
});

interface SignInFixture extends Fixture {
  accountResources: { installation: string; artifact: string; binding: string; signInBinding: string; enabled: boolean; ready: boolean; consents: JobDescription["consents"] };
  state: { revision: string | null; policy: ServicePolicy | null; writes: number; enabled: boolean;
    runtimeState: "ready" | "starting" | "stopped" | "unavailable";
    reason: string | null;
    owner: { machineId: string; name: string; online: boolean } };
}

function signInConsents(machineId: string): JobDescription["consents"] {
  return [
    ...[BROKER_OPERATION_ID, SIGN_IN_OPERATION_ID].flatMap(operationId =>
      (["machines:run", "network:host"] as const).map(cap => ({
        node: formatManifoldUri({ kind: "operation", machineId, operationId }),
        cap, enabled: true, revision: "permission-1",
      }))),
    { node: formatManifoldUri({ kind: "location", machineId, locationId: `${ACCOUNTS_PLUGIN_ID}.omp-auth` }),
      cap: "locations:write", enabled: true, revision: "permission-1" },
  ];
}

function signInFixture(isRoot = true): SignInFixture {
  const f = fixture(isRoot);
  const accountResources = { installation: "accounts-install-1", artifact: "f".repeat(64), binding: "a".repeat(64),
    signInBinding: "a".repeat(64), enabled: true, ready: true, consents: signInConsents(f.resources.brokerOwner) };
  const state = { revision: null as string | null, policy: null as ServicePolicy | null, writes: 0, enabled: true,
    runtimeState: "ready" as "ready" | "starting" | "stopped" | "unavailable", reason: null as string | null,
    owner: { machineId: f.resources.brokerOwner, name: "Broker owner", online: true } };
  const describe = f.ctx.services.describeInstance;
  f.ctx.services.describeInstance = async args => {
    const description = await describe(args);
    return { ...description, defaultOwner: { ...state.owner }, owner: state.revision ? { ...state.owner } : null,
      configuration: state.revision ? { ...description.configuration!, revision: state.revision, enabled: state.enabled,
        policySha256: digestOf(state.policy) } : null,
      connected: state.owner.online, state: state.revision ? state.runtimeState : "unconfigured", reason: state.reason };
  };
  const jobs = f.ctx.jobs.describe;
  f.ctx.jobs.describe = async args => {
    if (args.pluginId !== ACCOUNTS_PLUGIN_ID) return jobs(args);
    if (args.machineId !== f.resources.brokerOwner) return unavailable();
    return { machineId: args.machineId, pluginId: ACCOUNTS_PLUGIN_ID, connected: true, platforms: ["linux-x64"],
      admissionPublicKey: "-----BEGIN PUBLIC KEY-----offline-fixture",
      installation: { revision: accountResources.installation, artifactSha256: accountResources.artifact,
        enabled: accountResources.enabled, ready: accountResources.enabled, purgeRequested: false }, retainedInstallations: [],
      consents: accountResources.consents.map(consent => ({ ...consent, enabled: accountResources.enabled && consent.enabled })),
      operations: Object.fromEntries([BROKER_OPERATION_ID, SIGN_IN_OPERATION_ID].map(operation =>
        [operation, { ready: accountResources.enabled && accountResources.ready, reason: accountResources.enabled ? null : "installation_disabled",
          resourceBindingDigest: operation === SIGN_IN_OPERATION_ID ? accountResources.signInBinding : accountResources.binding }])) };
  };
  const allows = f.ctx.auth.allows;
  (f.ctx.auth.caps as Cap[]).push("services:configure", "network:host", "locations:write");
  f.ctx.auth.allows = async (cap, node) =>
    (cap === "services:configure" && node?.kind === "machine" && node.machineId === state.owner.machineId) ||
    (node?.kind === "operation" && node.machineId === state.owner.machineId &&
      [BROKER_OPERATION_ID, SIGN_IN_OPERATION_ID].includes(node.operationId) && ["machines:run", "network:host"].includes(cap)) ||
    (cap === "locations:write" && node?.kind === "location" && node.machineId === state.owner.machineId && node.locationId === `${ACCOUNTS_PLUGIN_ID}.omp-auth`) ||
    (cap === "terminals:spawn" && node?.kind === "container" && f.access.writable.has(node.containerId)) || allows(cap, node);
  f.ctx.services.readInstanceConfiguration = async args => {
    if (!f.ctx.auth.isRoot || !await f.ctx.auth.allows("services:configure", { kind: "machine", machineId: state.owner.machineId }))
      return unavailable();
    return { description: await f.ctx.services.describeInstance(args), policy: state.policy };
  };
  f.ctx.services.configureInstance = async args => {
    if (args.serviceId !== BROKER_SERVICE_ID || args.machineId !== state.owner.machineId) return unavailable();
    if (args.expectedRevision !== state.revision) throw new Error("native revision conflict");
    if (state.enabled === args.enabled && digestOf(state.policy) === digestOf(args.policy))
      return f.ctx.services.describeInstance({ serviceId: BROKER_SERVICE_ID });
    state.policy = args.policy;
    state.enabled = args.enabled;
    state.revision = `registry-${++state.writes}`;
    f.resources.brokerRevision = state.revision;
    return f.ctx.services.describeInstance({ serviceId: BROKER_SERVICE_ID });
  };
  return { ...f, state, accountResources };
}

describe("instance-owned OMP sign-in", () => {
  const input = { containerId: target.containerId, expectedBrokerRevision: null };

  test("initial runtime policy review is read-only and its promotion retains the native null-revision CAS", async () => {
    const f = signInFixture();
    const review = await accepted(f, "reviewAccountRuntime", { expectedBrokerRevision: null });
    expect(review.current).toBe(false);
    expect((await accepted(f, "readAccountSetup", {})).revision).toBeNull();
    expect(f.state.writes).toBe(0);
    f.state.runtimeState = "starting";
    const promotion = { containerId: target.containerId, expectedBrokerRevision: null, reviewDigest: review.reviewDigest };
    const applied = await accepted(f, "promoteAccountRuntime", promotion);
    expect(await accepted(f, "readAccountSetup", {})).toMatchObject({ revision: applied.revision, state: "starting" });
    expect(await invoke(f, "promoteAccountRuntime", promotion)).toEqual({ refused: "code_broker_revision_changed" });
    expect(f.state.writes).toBe(1);
    f.state.runtimeState = "ready";
    expect(await accepted(f, "readAccountSetup", {})).toMatchObject({ revision: applied.revision, state: "ready", canSignIn: true });
    expect((await accepted(f, "reviewAccountRuntime", { expectedBrokerRevision: applied.revision })).current).toBe(true);
  });

  test("initial configuration review cannot manufacture consent or adopt changed sign-in resources", async () => {
    const f = signInFixture();
    const approved = f.accountResources.consents;
    f.accountResources.consents = [];
    expect(await invoke(f, "reviewAccountRuntime", { expectedBrokerRevision: null })).toEqual({ refused: "code_native_consent_required" });
    f.accountResources.consents = approved;
    const review = await accepted(f, "reviewAccountRuntime", { expectedBrokerRevision: null });
    f.accountResources.signInBinding = "9".repeat(64);
    expect(await invoke(f, "promoteAccountRuntime", { containerId: target.containerId,
      expectedBrokerRevision: null, reviewDigest: review.reviewDigest })).toEqual({ refused: "code_preview_changed" });
    expect(f.state.writes).toBe(0);
    expect(f.state.policy).toBeNull();
  });

  test("sign-in requires current native consents before configuration and after revocation", async () => {
    const f = signInFixture();
    const approved = f.accountResources.consents;
    f.accountResources.consents = [];
    expect(await accepted(f, "readAccountSetup", {})).toMatchObject({
      revision: null, state: "unconfigured", canSignIn: false, canUpdateRuntime: false,
    });
    expect(await invoke(f, "prepareSignIn", input)).toEqual({ refused: "code_native_consent_required" });
    expect((await accepted(f, "readAccountSetup", {})).revision).toBeNull();
    f.accountResources.consents = approved;
    await accepted(f, "prepareSignIn", input);
    const revision = f.state.revision;
    const signInNode = formatManifoldUri({ kind: "operation", machineId: f.resources.brokerOwner, operationId: SIGN_IN_OPERATION_ID });
    f.accountResources.consents = approved.filter(consent => consent.node !== signInNode || consent.cap !== "network:host");
    expect(await accepted(f, "readAccountSetup", {})).toMatchObject({
      revision, canSignIn: false, canUpdateRuntime: false,
    });
    expect(await invoke(f, "prepareSignIn", { ...input, expectedBrokerRevision: revision }))
      .toEqual({ refused: "code_native_consent_required" });
    expect((await accepted(f, "readAccountSetup", {})).revision).toBe(revision);
  });

  test("maintenance is not a broker runtime upgrade", async () => {
    const f = signInFixture();
    await accepted(f, "prepareSignIn", input);
    const revision = f.state.revision;
    f.state.runtimeState = "unavailable";
    f.state.reason = "machine_draining";
    expect(await accepted(f, "readAccountSetup", {})).toMatchObject({
      revision, state: "unavailable", canSignIn: false, canUpdateRuntime: false,
    });
    expect(await invoke(f, "prepareSignIn", { ...input, expectedBrokerRevision: revision }))
      .toEqual({ refused: "code_broker_unavailable" });
    expect((await accepted(f, "readAccountSetup", {})).revision).toBe(revision);
  });

  test("first use configures one shared owner; workspace upgrades preserve sign-in and broker placement", async () => {
    const f = signInFixture();
    const worker = await initialize(f);
    const first = await accepted(f, "prepareSignIn", input);
    expect(first.machineId).toBe(f.resources.brokerOwner);
    expect(first.machineId).not.toBe(target.machineId);
    expect(first.runtime.operationId).toBe(SIGN_IN_OPERATION_ID);
    expect(f.state.policy?.runtime?.scope).toBe("instance");
    const policy = structuredClone(f.state.policy);
    f.resources.product = "e".repeat(64);
    f.resources.artifact = "e".repeat(64);
    f.resources.binding = "e".repeat(64);
    f.resources.installation = "worker-install-2";
    expect((await accepted(f, "readAccountSetup", {})).canSignIn).toBe(true);
    const second = await accepted(f, "prepareSignIn", { ...input, expectedBrokerRevision: f.state.revision });
    expect(second).toEqual(first);
    expect(f.state.writes).toBe(1);
    expect(f.state.policy).toEqual(policy);
    expect(await configuration(f)).toEqual(worker);
  });

  test("container scope and owner administration are required before broker mutation", async () => {
    const nonOwner = signInFixture(false);
    expect(await invoke(nonOwner, "prepareSignIn", input)).toEqual({ refused: "code_service_owner_required" });
    expect(nonOwner.state.writes).toBe(0);
    const f = signInFixture();
    f.access.writable.clear();
    expect(await invoke(f, "prepareSignIn", input)).toEqual({ refused: "code_scope_refused" });
    f.access.writable.add(target.containerId);
    f.access.containerScope = "container-b";
    expect(await invoke(f, "prepareSignIn", input)).toEqual({ refused: "code_scope_refused" });
    expect(f.state.writes).toBe(0);
  });

  test("an offline designated owner cannot be replaced by an available default or workspace worker", async () => {
    const f = signInFixture();
    await accepted(f, "prepareSignIn", input);
    f.state.owner.online = false;
    expect(await invoke(f, "prepareSignIn", { ...input, expectedBrokerRevision: f.state.revision }))
      .toEqual({ refused: "code_account_owner_unavailable" });
    expect(f.state.writes).toBe(1);
  });

  test("competing first-use writers cannot adopt or overwrite the winning native revision", async () => {
    const f = signInFixture();
    const results = await Promise.all([invoke(f, "prepareSignIn", input), invoke(f, "prepareSignIn", input)]);
    expect(results.filter(value => actionSchemas.prepareSignIn.result.safeParse(value).success)).toHaveLength(1);
    expect(results.filter(value => !actionSchemas.prepareSignIn.result.safeParse(value).success))
      .toEqual([{ refused: "code_broker_revision_changed" }]);
    expect(f.state.writes).toBe(1);
    expect(await invoke(f, "prepareSignIn", input)).toEqual({ refused: "code_broker_revision_changed" });
  });

  test("changed installed owner resources cannot silently replace an already configured broker", async () => {
    const f = signInFixture();
    await accepted(f, "prepareSignIn", input);
    f.accountResources.binding = "e".repeat(64);
    expect(await invoke(f, "prepareSignIn", { ...input, expectedBrokerRevision: f.state.revision }))
      .toEqual({ refused: "code_resources_changed" });
    expect(f.state.writes).toBe(1);
  });

  test("a cancelled broker exposes native recovery blockers and recovers only through explicit review", async () => {
    const f = signInFixture();
    await accepted(f, "prepareSignIn", input);
    f.state.runtimeState = "unavailable";
    f.state.reason = "cancelled";
    f.accountResources.enabled = false;
    const expectedBrokerRevision = f.state.revision!;
    const disabled = await accepted(f, "readAccountSetup", {});
    expect(disabled).toMatchObject({
      revision: expectedBrokerRevision, state: "unavailable", canSignIn: false, canUpdateRuntime: false,
    });
    expect(disabled.reason).toContain("installation_disabled");
    expect(disabled.reason).toContain("cancelled");
    expect(await invoke(f, "reviewAccountRuntime", { expectedBrokerRevision }))
      .toEqual({ refused: "code_installation_disabled" });
    expect(f.state.writes).toBe(1);

    // Re-enabling the same installation cannot stand in for missing native consent.
    f.accountResources.enabled = true;
    const approved = f.accountResources.consents;
    f.accountResources.consents = [];
    expect(await accepted(f, "readAccountSetup", {})).toMatchObject({
      revision: expectedBrokerRevision, canSignIn: false, canUpdateRuntime: false,
    });
    expect(await invoke(f, "reviewAccountRuntime", { expectedBrokerRevision }))
      .toEqual({ refused: "code_native_consent_required" });
    expect(f.state.writes).toBe(1);
    f.accountResources.consents = approved;

    expect(await accepted(f, "readAccountSetup", {})).toMatchObject({
      revision: expectedBrokerRevision, state: "unavailable", canSignIn: false, canUpdateRuntime: true,
    });
    const review = await accepted(f, "reviewAccountRuntime", { expectedBrokerRevision });
    expect(await invoke(f, "prepareSignIn", { ...input, expectedBrokerRevision }))
      .toEqual({ refused: "code_broker_unavailable" });
    expect(f.state.writes).toBe(1);
    const configure = f.ctx.services.configureInstance;
    f.ctx.services.configureInstance = async args => {
      const previousRevision = f.state.revision;
      const result = await configure(args);
      if (f.state.revision !== previousRevision) {
        f.state.runtimeState = "starting";
        f.state.reason = "instance_service_starting";
      }
      return result;
    };
    const promoted = await accepted(f, "promoteAccountRuntime", {
      containerId: target.containerId, expectedBrokerRevision, reviewDigest: review.reviewDigest,
    });
    expect(promoted.revision).not.toBe(expectedBrokerRevision);
    expect(await invoke(f, "prepareSignIn", { ...input, expectedBrokerRevision }))
      .toEqual({ refused: "code_broker_revision_changed" });
    await accepted(f, "prepareSignIn", { ...input, expectedBrokerRevision: promoted.revision });
    expect(await accepted(f, "readAccountSetup", {})).toMatchObject({
      revision: promoted.revision, state: "starting", canSignIn: true, canUpdateRuntime: false,
    });
  });

  test("a recovered broker invalidates a stale recovery review before any configuration write", async () => {
    const f = signInFixture();
    await accepted(f, "prepareSignIn", input);
    f.state.runtimeState = "unavailable";
    const review = await accepted(f, "reviewAccountRuntime", { expectedBrokerRevision: f.state.revision! });
    f.state.runtimeState = "ready";
    expect(await invoke(f, "promoteAccountRuntime", {
      containerId: target.containerId, expectedBrokerRevision: review.expectedBrokerRevision, reviewDigest: review.reviewDigest,
    })).toEqual({ refused: "code_preview_changed" });
    expect(f.state.writes).toBe(1);
    expect(await accepted(f, "readAccountSetup", {})).toMatchObject({ state: "ready", canSignIn: true, canUpdateRuntime: false });
  });

  test("an installed account replacement requires explicit review before the new registry revision can be reused", async () => {
    const f = signInFixture();
    await accepted(f, "prepareSignIn", input);
    const expectedBrokerRevision = f.state.revision!;
    const previousPolicy = structuredClone(f.state.policy);
    f.accountResources.installation = "accounts-install-2";
    f.accountResources.artifact = "e".repeat(64);
    expect(await invoke(f, "prepareSignIn", { ...input, expectedBrokerRevision })).toEqual({ refused: "code_resources_changed" });
    expect(await accepted(f, "readAccountSetup", {})).toMatchObject({ canSignIn: false, canUpdateRuntime: true });
    f.state.runtimeState = "stopped";
    expect(await accepted(f, "readAccountSetup", {})).toMatchObject({ state: "unavailable", canSignIn: false, canUpdateRuntime: true });
    const review = await accepted(f, "reviewAccountRuntime", { expectedBrokerRevision });
    expect(f.state.writes).toBe(1);
    expect(f.state.policy).toEqual(previousPolicy);
    const configure = f.ctx.services.configureInstance;
    f.ctx.services.configureInstance = async args => {
      f.state.runtimeState = "starting";
      return configure(args);
    };
    const promoted = await accepted(f, "promoteAccountRuntime", {
      containerId: target.containerId, expectedBrokerRevision, reviewDigest: review.reviewDigest,
    });
    expect(promoted.revision).not.toBe(expectedBrokerRevision);
    expect(await accepted(f, "readAccountSetup", {})).toMatchObject({
      revision: promoted.revision, state: "starting", canSignIn: true, canUpdateRuntime: false,
    });
    expect(await invoke(f, "prepareSignIn", { ...input, expectedBrokerRevision })).toEqual({ refused: "code_broker_revision_changed" });
    const terminal = await accepted(f, "prepareSignIn", { ...input, expectedBrokerRevision: promoted.revision });
    expect(terminal.machineId).toBe(f.state.owner.machineId);
    expect(terminal.runtime.installationRevision).toBe("accounts-install-2");
    expect(f.state.writes).toBe(2);
  });

  const proposalChanges: [string, (f: SignInFixture) => void][] = [
    ["installation", f => { f.accountResources.installation = "accounts-install-3"; }],
    ["artifact", f => { f.accountResources.artifact = "d".repeat(64); }],
    ["broker resources", f => { f.accountResources.binding = "d".repeat(64); }],
    ["sign-in resources", f => { f.accountResources.signInBinding = "d".repeat(64); }],
    ["current policy", f => { f.state.policy = { ...f.state.policy!, maxConcurrent: 2 }; }],
    ["owner", f => {
      f.state.owner.machineId = f.resources.brokerOwner = "replacement-owner";
      f.accountResources.consents = signInConsents(f.resources.brokerOwner);
    }],
  ];
  for (const [name, change] of proposalChanges) {
    test(`a reviewed account runtime cannot be applied after ${name} changes`, async () => {
      const f = signInFixture();
      await accepted(f, "prepareSignIn", input);
      f.accountResources.installation = "accounts-install-2";
      const review = await accepted(f, "reviewAccountRuntime", { expectedBrokerRevision: f.state.revision! });
      change(f);
      expect(await invoke(f, "promoteAccountRuntime", { containerId: target.containerId,
        expectedBrokerRevision: review.expectedBrokerRevision, reviewDigest: review.reviewDigest }))
        .toEqual({ refused: "code_preview_changed" });
      expect(f.state.writes).toBe(1);
    });
  }

  test("relocation to a new native revision invalidates the old review without configuring either owner", async () => {
    const f = signInFixture();
    await accepted(f, "prepareSignIn", input);
    f.accountResources.installation = "accounts-install-2";
    const review = await accepted(f, "reviewAccountRuntime", { expectedBrokerRevision: f.state.revision! });
    f.state.owner.machineId = "replacement-owner";
    f.state.revision = "relocated-revision";
    expect(await invoke(f, "promoteAccountRuntime", { containerId: target.containerId,
      expectedBrokerRevision: review.expectedBrokerRevision, reviewDigest: review.reviewDigest }))
      .toEqual({ refused: "code_broker_revision_changed" });
    expect(f.state.writes).toBe(1);
  });

  test("nonowners retain account metadata reads but cannot inspect or promote runtime policy", async () => {
    const f = signInFixture();
    await accepted(f, "prepareSignIn", input);
    f.accountResources.installation = "accounts-install-2";
    const review = await accepted(f, "reviewAccountRuntime", { expectedBrokerRevision: f.state.revision! });
    f.access.isRoot = false;
    expect(await accepted(f, "readAccountSetup", {})).toMatchObject({
      revision: review.expectedBrokerRevision, owner: f.state.owner, canSignIn: false, canUpdateRuntime: false,
    });
    expect((await accepted(f, "accounts", {})).accounts.map(account => account.credentialId)).toEqual([1, 2, 3]);
    expect(await invoke(f, "reviewAccountRuntime", { expectedBrokerRevision: review.expectedBrokerRevision }))
      .toEqual({ refused: "code_service_owner_required" });
    expect(await invoke(f, "promoteAccountRuntime", { containerId: target.containerId,
      expectedBrokerRevision: review.expectedBrokerRevision, reviewDigest: review.reviewDigest }))
      .toEqual({ refused: "code_service_owner_required" });
    f.access.isRoot = true;
    const allows = f.ctx.auth.allows;
    f.ctx.auth.allows = async (cap, node) => cap !== "services:configure" && allows(cap, node);
    expect(await invoke(f, "promoteAccountRuntime", { containerId: target.containerId,
      expectedBrokerRevision: review.expectedBrokerRevision, reviewDigest: review.reviewDigest }))
      .toEqual({ refused: "code_service_owner_required" });
    expect(f.state.writes).toBe(1);
  });

  test("runtime promotion requires a writable in-scope container", async () => {
    const f = signInFixture();
    await accepted(f, "prepareSignIn", input);
    f.accountResources.installation = "accounts-install-2";
    const review = await accepted(f, "reviewAccountRuntime", { expectedBrokerRevision: f.state.revision! });
    const promotion = { containerId: target.containerId, expectedBrokerRevision: review.expectedBrokerRevision, reviewDigest: review.reviewDigest };
    f.access.writable.clear();
    expect(await invoke(f, "promoteAccountRuntime", promotion)).toEqual({ refused: "code_scope_refused" });
    f.access.writable.add(target.containerId);
    f.access.containerScope = "container-b";
    expect(await invoke(f, "promoteAccountRuntime", promotion)).toEqual({ refused: "code_scope_refused" });
    expect(f.state.writes).toBe(1);
  });

  test("disabled brokers and unready or offline owners cannot be made available by runtime promotion", async () => {
    const f = signInFixture();
    await accepted(f, "prepareSignIn", input);
    f.accountResources.installation = "accounts-install-2";
    const review = await accepted(f, "reviewAccountRuntime", { expectedBrokerRevision: f.state.revision! });
    const promotion = { containerId: target.containerId, expectedBrokerRevision: review.expectedBrokerRevision, reviewDigest: review.reviewDigest };
    f.state.enabled = false;
    expect(await accepted(f, "readAccountSetup", {})).toMatchObject({ state: "unavailable", canSignIn: false, canUpdateRuntime: false });
    expect(await invoke(f, "reviewAccountRuntime", { expectedBrokerRevision: review.expectedBrokerRevision }))
      .toEqual({ refused: "code_broker_unavailable" });
    expect(await invoke(f, "promoteAccountRuntime", promotion)).toEqual({ refused: "code_broker_unavailable" });
    expect(await invoke(f, "prepareSignIn", { ...input, expectedBrokerRevision: f.state.revision }))
      .toEqual({ refused: "code_broker_unavailable" });
    expect(f.state.enabled).toBe(false);
    f.state.enabled = true;
    f.accountResources.ready = false;
    expect(await accepted(f, "readAccountSetup", {})).toMatchObject({ canSignIn: false, canUpdateRuntime: false });
    expect(await invoke(f, "promoteAccountRuntime", promotion)).toEqual({ refused: "code_resources_incomplete" });
    f.accountResources.ready = true;
    f.state.owner.online = false;
    expect(await accepted(f, "readAccountSetup", {})).toMatchObject({ canSignIn: false, canUpdateRuntime: false });
    expect(await invoke(f, "promoteAccountRuntime", promotion)).toEqual({ refused: "code_account_owner_unavailable" });
    expect(f.state.writes).toBe(1);
  });

  test("resources changed during promotion inspection invalidate the proposal before mutation", async () => {
    const f = signInFixture();
    await accepted(f, "prepareSignIn", input);
    f.accountResources.installation = "accounts-install-2";
    const review = await accepted(f, "reviewAccountRuntime", { expectedBrokerRevision: f.state.revision! });
    const describe = f.ctx.jobs.describe;
    let reads = 0;
    f.ctx.jobs.describe = async args => {
      const description = await describe(args);
      if (args.pluginId === ACCOUNTS_PLUGIN_ID && ++reads === 1) f.accountResources.signInBinding = "d".repeat(64);
      return description;
    };
    expect(await invoke(f, "promoteAccountRuntime", { containerId: target.containerId,
      expectedBrokerRevision: review.expectedBrokerRevision, reviewDigest: review.reviewDigest }))
      .toEqual({ refused: "code_resources_changed" });
    expect(f.state.writes).toBe(1);
  });

  test("native CAS rejects a registry change after the final promotion observation", async () => {
    const f = signInFixture();
    await accepted(f, "prepareSignIn", input);
    f.accountResources.installation = "accounts-install-2";
    const review = await accepted(f, "reviewAccountRuntime", { expectedBrokerRevision: f.state.revision! });
    const configure = f.ctx.services.configureInstance;
    f.ctx.services.configureInstance = async args => {
      f.state.revision = "concurrent-revision";
      return configure(args);
    };
    expect(await invoke(f, "promoteAccountRuntime", { containerId: target.containerId,
      expectedBrokerRevision: review.expectedBrokerRevision, reviewDigest: review.reviewDigest }))
      .toEqual({ refused: "code_broker_revision_changed" });
    expect(f.state.writes).toBe(1);
  });

  test("owner relocation during policy inspection invalidates sign-in without reconfiguring either owner", async () => {
    const f = signInFixture();
    await accepted(f, "prepareSignIn", input);
    const expectedBrokerRevision = f.state.revision;
    const read = f.ctx.services.readInstanceConfiguration;
    f.ctx.services.readInstanceConfiguration = async args => {
      const current = await read(args);
      f.state.owner.machineId = "replacement-owner";
      f.state.revision = "relocated-revision";
      return current;
    };
    expect(await invoke(f, "prepareSignIn", { ...input, expectedBrokerRevision }))
      .toEqual({ refused: "code_broker_revision_changed" });
    expect(f.state.writes).toBe(1);
  });
});

function runtimeSetupFixture(isRoot = true) {
  const f = fixture(isRoot);
  const state = { configuration: { revision: null, policies: [] } as ServiceConfiguration, writes: 0,
    enabled: true, connected: true, configureAllowed: true };
  const runtime = { pluginId: GATEWAY_PLUGIN_ID, operationId: GATEWAY_OPERATION_ID,
    installationRevision: "gateway-install-1", artifactSha256: "e".repeat(64), resourceBindingDigest: "f".repeat(64) };
  const allows = f.ctx.auth.allows;
  f.ctx.auth.allows = async (cap, node) =>
    (state.configureAllowed && cap === "services:configure" && node?.kind === "machine" && node.machineId === target.machineId) || allows(cap, node);
  const describe = f.ctx.jobs.describe;
  f.ctx.jobs.describe = async args => {
    if (args.pluginId !== CODE_PLUGIN_ID) throw new Error("Native job descriptions are plugin-scoped");
    return describe(args);
  };
  f.ctx.services.readConfiguration = async () => ({
    configuration: structuredClone(state.configuration), connected: state.connected, credentialReferences: [],
    runtimeCandidates: [{ runtime: { ...runtime }, ready: state.enabled && state.connected,
      reason: !state.connected ? "resource_owner_unavailable" : state.enabled ? null : "installation_disabled" }],
  });
  f.ctx.services.configureConfiguration = async args => {
    if (args.machineId !== target.machineId || args.expectedRevision !== state.configuration.revision)
      throw new Error("native service configuration conflict");
    state.configuration = ServiceConfigurationSchema.parse({ revision: digestOf(args.policies), policies: args.policies });
    state.writes++;
    return structuredClone(state.configuration);
  };
  return { ...f, state, runtime };
}

describe("native machine execution service setup", () => {
  const input = { ...target, expectedServiceRevision: null };

  test("first use reviews and configures a gateway without inspecting or provisioning shared accounts", async () => {
    const f = runtimeSetupFixture();
    f.ctx.services.describeInstance = unavailable;
    const initial = await accepted(f, "readServiceConfiguration", target);
    expect(initial.configuration).toEqual({ revision: null, policies: [] });
    const reviewed = await accepted(f, "reviewServices", input);
    expect(await accepted(f, "reviewServices", input)).toEqual(reviewed);
    expect(f.state.writes).toBe(0);
    const configured = await accepted(f, "configureServices", { ...input, reviewDigest: reviewed.reviewDigest });
    expect(configured.policies.map(policy => policy.serviceId)).toEqual(["omp"]);
    expect(configured.policies[0]?.runtime).toEqual({ ...f.runtime, input: { accountPool: { input: "accountPool" } } });
    expect((await accepted(f, "readServiceConfiguration", target)).configuration).toEqual(configured);
    expect(await configuration(f)).toBeNull();
  });

  test("disabled native candidates remain observable but cannot be reviewed into availability", async () => {
    const f = runtimeSetupFixture();
    f.state.enabled = false;
    expect((await accepted(f, "readServiceConfiguration", target)).runtimeCandidates[0])
      .toMatchObject({ ready: false, reason: "installation_disabled" });
    expect(await invoke(f, "reviewServices", input)).toEqual({ refused: "code_resources_incomplete" });
    expect(f.state.writes).toBe(0);
  });

  test("classifier changes preserve unrelated machine policies, including a preexisting broker", async () => {
    const f = runtimeSetupFixture();
    const classifier = { origin: "http://127.0.0.1:11434", model: "qwen3:8b" };
    const suggest = buildCodeServices({ classifier })[0]!;
    const broker = { ...suggest, serviceId: BROKER_SERVICE_ID, revision: "existing-broker" };
    f.state.configuration = { revision: digestOf([broker, suggest]), policies: [broker, suggest] };
    const preserved = await accepted(f, "reviewServices", { ...target, expectedServiceRevision: f.state.configuration.revision });
    const configured = await accepted(f, "configureServices", { ...target,
      expectedServiceRevision: preserved.expectedServiceRevision, reviewDigest: preserved.reviewDigest });
    expect(configured.policies.filter(policy => policy.serviceId !== "omp")).toEqual([broker, suggest]);
    const removed = await accepted(f, "reviewServices", { ...target, expectedServiceRevision: configured.revision, classifier: null });
    const withoutClassifier = await accepted(f, "configureServices", { ...target,
      expectedServiceRevision: configured.revision, classifier: null, reviewDigest: removed.reviewDigest });
    expect(withoutClassifier.policies.map(policy => policy.serviceId)).toEqual([BROKER_SERVICE_ID, "omp"]);
    const replacement = { ...classifier, model: "qwen3:14b" };
    const added = await accepted(f, "reviewServices", { ...target, expectedServiceRevision: withoutClassifier.revision, classifier: replacement });
    const withClassifier = await accepted(f, "configureServices", { ...target, expectedServiceRevision: withoutClassifier.revision,
      classifier: replacement, reviewDigest: added.reviewDigest });
    expect(withClassifier.policies.find(policy => policy.serviceId === "suggest")).toEqual(buildCodeServices({ classifier: replacement })[0]);
    expect(withClassifier.policies.find(policy => policy.serviceId === BROKER_SERVICE_ID)).toEqual(broker);
  });

  test("configuration inspection and mutation require native owner authority and a writable in-scope target", async () => {
    const nonOwner = runtimeSetupFixture(false);
    expect(await invoke(nonOwner, "readServiceConfiguration", target)).toEqual({ refused: "code_service_owner_required" });
    expect(await invoke(nonOwner, "reviewServices", input)).toEqual({ refused: "code_service_owner_required" });
    expect(await invoke(nonOwner, "configureServices", { ...input, reviewDigest: "a".repeat(64) }))
      .toEqual({ refused: "code_service_owner_required" });
    expect(nonOwner.state.writes).toBe(0);
    const f = runtimeSetupFixture();
    const reviewed = await accepted(f, "reviewServices", input);
    const configure = { ...input, reviewDigest: reviewed.reviewDigest };
    f.state.configureAllowed = false;
    expect(await invoke(f, "configureServices", configure)).toEqual({ refused: "code_service_owner_required" });
    f.state.configureAllowed = true;
    f.access.writable.clear();
    expect(await invoke(f, "configureServices", configure)).toEqual({ refused: "code_scope_refused" });
    f.access.writable.add(target.containerId);
    f.access.containerScope = "container-b";
    expect(await invoke(f, "configureServices", configure)).toEqual({ refused: "code_scope_refused" });
    expect(f.state.writes).toBe(0);
  });

  test("a concurrent native configuration cannot be overwritten by an old review", async () => {
    const f = runtimeSetupFixture();
    const reviewed = await accepted(f, "reviewServices", input);
    await f.ctx.services.configureConfiguration({ machineId: target.machineId, expectedRevision: null, policies: [] });
    expect(await invoke(f, "configureServices", { ...input, reviewDigest: reviewed.reviewDigest }))
      .toEqual({ refused: "code_service_configuration_changed" });
    expect(f.state.writes).toBe(1);
    expect(f.state.configuration.policies).toEqual([]);
  });

  test("a changed gateway pin invalidates the old review before writing any policy", async () => {
    const f = runtimeSetupFixture();
    const reviewed = await accepted(f, "reviewServices", input);
    f.runtime.resourceBindingDigest = "a".repeat(64);
    expect(await invoke(f, "configureServices", { ...input, reviewDigest: reviewed.reviewDigest }))
      .toEqual({ refused: "code_preview_changed" });
    expect(f.state.writes).toBe(0);
  });

  test("gateway replacement during configuration reinspection cannot admit a stale candidate", async () => {
    const f = runtimeSetupFixture();
    const reviewed = await accepted(f, "reviewServices", input);
    const read = f.ctx.services.readConfiguration;
    f.ctx.services.readConfiguration = async args => {
      const result = await read(args);
      f.runtime.installationRevision = "gateway-install-2";
      return result;
    };
    expect(await invoke(f, "configureServices", { ...input, reviewDigest: reviewed.reviewDigest }))
      .toEqual({ refused: "code_resources_changed" });
    expect(f.state.writes).toBe(0);
  });

  test("setup distinguishes instance revisions from per-machine broker policy authority", async () => {
    const f = fixture();
    const observed = await f.ctx.services.describe({ machineId: target.machineId });
    f.ctx.services.describe = async () => observed;
    const promoted = await active(f);
    expect((await accepted(f, "readSetup", target)).services).toContainEqual({
      ...promoted.resourcesByMachine[target.machineId]!.services.broker!, operations: observed.services[0]!.operations,
    });
    const preview = await accepted(f, "previewLaunch", { ...target, expectedRevision: promoted.revision });
    f.resources.brokerRevision = "configuration-revision-2";
    expect(await invoke(f, "prepareLaunch", { ...target, expectedRevision: promoted.revision, previewDigest: preview.previewDigest, prompt: "" }))
      .toEqual({ refused: "code_resources_changed" });
    expect((await accepted(f, "readSetup", target)).services).toContainEqual({
      serviceId: BROKER_SERVICE_ID, revision: "configuration-revision-2", policySha256: f.resources.policy,
      operations: observed.services[0]!.operations,
    });
    f.resources.policy = "e".repeat(64);
    expect((await accepted(f, "readSetup", target)).services).toContainEqual({
      serviceId: BROKER_SERVICE_ID, revision: "configuration-revision-2", policySha256: f.resources.policy, operations: [],
    });
  });

  test("setup can pin the instance broker without inventing machine-local authority", async () => {
    const f = fixture();
    const observe = f.ctx.services.describe;
    f.ctx.services.describe = async ({ machineId }) => ({ machineId, connected: true, services: [] });
    expect((await accepted(f, "readSetup", target)).services).toEqual([{
      serviceId: BROKER_SERVICE_ID, revision: f.resources.brokerRevision, policySha256: f.resources.policy, operations: [],
    }]);
    f.ctx.services.describe = observe;
    const describe = f.ctx.services.describeInstance;
    f.ctx.services.describeInstance = async args => ({ ...await describe(args), configuration: null, owner: null, state: "unconfigured" });
    expect((await accepted(f, "readSetup", target)).services).toEqual([]);
  });
});
