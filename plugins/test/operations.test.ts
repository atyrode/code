import { describe, expect, test } from "bun:test";
import { InstanceServiceDescriptionSchema, PluginRosterEntrySchema, ServiceReplySchema, type ServicePolicy } from "@manifold/protocol";
import { actionSchemas, CODE_PLUGIN_ID, type ActionInput, type ActionResult, type CodeAction, type Target } from "../atyrode.code/contract.ts";
import { BROKER_OPERATION_ID, BROKER_SERVICE_ID, SIGN_IN_OPERATION_ID } from "../atyrode.code/auth-contract.ts";
import type { CodeContext } from "../atyrode.code/machine-server.ts";
import { handlers } from "../atyrode.code/server.ts";
import type { CatalogDocument } from "../domain/contracts.ts";
import type { ProjectedBrokerSnapshot } from "../domain/accounts.ts";

const target: Target = { containerId: "container-a", machineId: "machine-a" };
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
  access: { containerScope: string | null; readable: Set<string>; writable: Set<string> };
  resources: { product: string; artifact: string; binding: string; installation: string; brokerRevision: string; brokerOwner: string; policy: string };
  metadata: ProjectedBrokerSnapshot;
  holdTwoReads(): void;
  duringMetadata(hook: () => Promise<void>): void;
}

function fixture(isRoot = false): Fixture {
  const store = new Map<string, string>();
  const access = { containerScope: null as string | null, readable: new Set(["container-a", "container-b"]), writable: new Set(["container-a", "container-b"]) };
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
      containerScope: null, isRoot,
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
      describe: async ({ machineId }) => ({ machineId, pluginId: CODE_PLUGIN_ID, connected: true, platforms: ["linux-x64"],
        admissionPublicKey: "-----BEGIN PUBLIC KEY-----offline-fixture",
        installation: { revision: resources.installation, artifactSha256: resources.artifact, enabled: true, ready: true, purgeRequested: false },
        retainedInstallations: [], consents: [],
        operations: { [`${CODE_PLUGIN_ID}.launch`]: { ready: true, reason: null, resourceBindingDigest: resources.binding } },
      }),
      execute: unavailable, status: unavailable, listRuns: unavailable, input: unavailable,
      cancel: unavailable, output: unavailable, follow: unavailable,
    },
    services: {
      describe: async ({ machineId }) => ({ machineId, connected: true, services: [{
        serviceId: BROKER_SERVICE_ID, revision: resources.brokerRevision, policySha256: resources.policy,
        operations: [{ operationId: "metadata", readable: true, invocable: false, ready: true, reason: null }],
      }] }),
      describeInstance: async () => InstanceServiceDescriptionSchema.parse({
        serviceId: BROKER_SERVICE_ID, defaultOwner: { machineId: "local-master", name: "Local master", online: true },
        owner: { machineId: resources.brokerOwner, name: "Broker owner", online: true },
        configuration: { revision: resources.brokerRevision, pluginId: CODE_PLUGIN_ID, enabled: true, policySha256: resources.policy },
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

async function invoke<K extends CodeAction>(f: Fixture, name: K, input: ActionInput<K>): Promise<unknown> {
  const handler = (handlers as Record<string, (ctx: CodeContext, input: unknown) => Promise<unknown>>)[name]!;
  return handler(f.ctx, input);
}
async function accepted<K extends CodeAction>(f: Fixture, name: K, input: ActionInput<K>): Promise<ActionResult<K>> {
  return actionSchemas[name].result.parse(await invoke(f, name, input)) as ActionResult<K>;
}
async function initialize(f: Fixture, scope = target) {
  return accepted(f, "initializeConfiguration", { ...scope, expectedRevision: 0 });
}
async function staged(f: Fixture, catalog = document()) {
  await initialize(f);
  return accepted(f, "stageCatalog", { ...target, expectedRevision: 1, document: catalog });
}
async function active(f: Fixture) {
  const record = await staged(f);
  const review = await accepted(f, "reviewCatalog", { ...target, expectedRevision: record.revision, source: "draft" });
  return accepted(f, "promoteCatalog", { ...target, expectedRevision: record.revision, source: "draft", reviewDigest: review.reviewDigest });
}
async function configuration(f: Fixture, scope = target) {
  return (await accepted(f, "readConfiguration", scope)).configuration;
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

describe("canonical typed Code actions", () => {
  test("competing same-revision writers commit once and a stale retry cannot overwrite the winner", async () => {
    const f = fixture();
    await initialize(f);
    f.holdTwoReads();
    const results = await Promise.all(["first", "second"].map(id => invoke(f, "changeAccounts", {
      ...target, expectedRevision: 1, change: { kind: "create-preset", preset: { id, name: id, disabled: [] } },
    })));
    expect(results.filter(result => actionSchemas.changeAccounts.result.safeParse(result).success)).toHaveLength(1);
    expect(results.filter(result => !actionSchemas.changeAccounts.result.safeParse(result).success)).toEqual([{ refused: "code_stale_preferences" }]);
    const winner = await configuration(f);
    expect(winner?.revision).toBe(2);
    expect(winner?.accounts.presets).toHaveLength(1);
    const loser = winner!.accounts.presets[0]!.id === "first" ? "second" : "first";
    expect(await invoke(f, "changeAccounts", { ...target, expectedRevision: 1,
      change: { kind: "create-preset", preset: { id: loser, name: loser, disabled: [] } },
    })).toEqual({ refused: "code_stale_preferences" });
    expect(await configuration(f)).toEqual(winner);
  });

  test("canonical state is isolated by container and machine, not action arguments", async () => {
    const f = fixture();
    const scopes = [target, { ...target, containerId: "container-b" }, { ...target, machineId: "machine-b" }];
    for (const scope of scopes) await initialize(f, scope);
    await accepted(f, "changeAccounts", { ...target, expectedRevision: 1,
      change: { kind: "create-preset", preset: { id: "private", name: "Private", disabled: [] } },
    });
    const first = await configuration(f);
    expect(first?.accounts.presets.map(preset => preset.id)).toEqual(["private"]);
    expect(first).not.toHaveProperty("expectedRevision");
    expect(first).not.toHaveProperty("change");
    for (const scope of scopes.slice(1)) {
      expect(await accepted(f, "readConfiguration", scope)).toMatchObject({ revision: 1, configuration: { ...scope, accounts: { presets: [] } } });
    }
    expect(await accepted(f, "readConfiguration", { ...target, machineId: "uninitialized" })).toEqual({ revision: 0, configuration: null });
  });

  test("read-only authority can read its container but cannot mutate it or disclose a different container", async () => {
    const f = fixture();
    const original = await initialize(f);
    await initialize(f, { ...target, containerId: "container-b" });
    f.access.writable.clear();
    f.access.readable.delete("container-b");
    expect(await configuration(f)).toEqual(original);
    expect(await invoke(f, "changeAccounts", { ...target, expectedRevision: 1,
      change: { kind: "create-preset", preset: { id: "forbidden", name: "Forbidden", disabled: [] } },
    })).toEqual({ refused: "code_scope_refused" });
    expect(await invoke(f, "readConfiguration", { ...target, containerId: "container-b" })).toEqual({ refused: "code_scope_refused" });
    expect(await configuration(f)).toEqual(original);
    f.access.readable.add("container-b");
    f.access.writable.add("container-b");
    f.access.containerScope = "container-a";
    const foreign = { ...target, containerId: "container-b" };
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

  for (const [name, change] of resourceChanges) {
    test(`catalog and resource promotion refuse changed ${name}`, async () => {
      const f = fixture();
      await staged(f);
      const catalog = await accepted(f, "reviewCatalog", { ...target, expectedRevision: 2, source: "draft" });
      const resources = await accepted(f, "reviewResources", { ...target, expectedRevision: 2 });
      change(f);
      expect(await invoke(f, "promoteCatalog", { ...target, expectedRevision: 2, source: "draft", reviewDigest: catalog.reviewDigest })).toEqual({ refused: "code_preview_changed" });
      expect(await invoke(f, "promoteResources", { ...target, expectedRevision: 2, reviewDigest: resources.reviewDigest })).toEqual({ refused: "code_preview_changed" });
      expect(await configuration(f)).toMatchObject({ revision: 2, active: null, resources: null });
    });
  }
});

describe("exact native launch preview", () => {
  test("a worker launches with shared account choices without executing on the broker owner or enabling disabled slots", async () => {
    const f = fixture();
    const describe = f.ctx.jobs.describe;
    f.ctx.jobs.describe = args => args.machineId === target.machineId ? describe(args) : unavailable();
    const record = await active(f);
    const accounts = await accepted(f, "accounts", {});
    const disabled = accounts.accounts.find(account => account.credentialId === 2)!.reference;
    const changed = await accepted(f, "changeAccounts", { ...target, expectedRevision: record.revision, change: { kind: "set-account", reference: disabled, enabled: false } });
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
      let changed = await accepted(f, "changeAccounts", { ...target, expectedRevision: record.revision, change: { kind: "set-account", reference, enabled: false } });
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
    const changed = await accepted(f, "select", { ...target, expectedRevision: record.revision, selection: { ...record.selection!, planYolo: !record.selection!.planYolo } });
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
        await accepted(f, "select", { ...target, expectedRevision: record.revision, selection: { ...record.selection!, planYolo: !record.selection!.planYolo } });
      });
      const input = { ...target, expectedRevision: record.revision, previewDigest: preview.previewDigest, prompt: "Run" };
      expect(await invoke(f, action, action === "previewLaunch" ? { ...target, expectedRevision: record.revision } : input)).toEqual({ refused: "code_stale_preferences" });
      expect((await configuration(f))?.selection?.planYolo).toBe(!record.selection!.planYolo);
    });
  }
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
    await accepted(f, "changeAccounts", { ...target, expectedRevision: record.revision,
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
    .toEqual({ refused: "code_account_unavailable" });
});

function signInFixture(isRoot = true) {
  const f = fixture(isRoot);
  const state = { revision: null as string | null, policy: null as ServicePolicy | null, writes: 0,
    owner: { machineId: f.resources.brokerOwner, name: "Broker owner", online: true } };
  const describe = f.ctx.services.describeInstance;
  f.ctx.services.describeInstance = async args => {
    const description = await describe(args);
    return { ...description, defaultOwner: { ...state.owner }, owner: state.revision ? { ...state.owner } : null,
      configuration: state.revision ? { ...description.configuration!, revision: state.revision } : null,
      connected: state.owner.online, state: state.revision ? "ready" : "unconfigured" };
  };
  const jobs = f.ctx.jobs.describe;
  f.ctx.jobs.describe = async args => {
    if (args.machineId !== state.owner.machineId) return unavailable();
    const description = await jobs(args);
    return { ...description, operations: Object.fromEntries([BROKER_OPERATION_ID, SIGN_IN_OPERATION_ID].map(operation =>
      [operation, { ready: true, reason: null, resourceBindingDigest: f.resources.binding }])) };
  };
  const allows = f.ctx.auth.allows;
  f.ctx.auth.allows = async (cap, node) =>
    (cap === "services:configure" && node?.kind === "machine" && node.machineId === state.owner.machineId) || allows(cap, node);
  f.ctx.services.readInstanceConfiguration = async args => ({ description: await f.ctx.services.describeInstance(args), policy: state.policy });
  f.ctx.services.configureInstance = async args => {
    if (args.serviceId !== BROKER_SERVICE_ID || args.machineId !== state.owner.machineId) return unavailable();
    if (args.expectedRevision !== state.revision) throw new Error("native revision conflict");
    state.policy = args.policy;
    state.revision = `registry-${++state.writes}`;
    return f.ctx.services.describeInstance({ serviceId: BROKER_SERVICE_ID });
  };
  return { ...f, state };
}

describe("instance-owned OMP sign-in", () => {
  const input = { containerId: target.containerId, expectedBrokerRevision: null };

  test("first use configures one shared owner; later sign-in preserves that broker and worker placement", async () => {
    const f = signInFixture();
    const worker = await initialize(f);
    const first = await accepted(f, "prepareSignIn", input);
    expect(first.machineId).toBe(f.resources.brokerOwner);
    expect(first.machineId).not.toBe(target.machineId);
    expect(first.runtime.operationId).toBe(SIGN_IN_OPERATION_ID);
    expect(f.state.policy?.runtime?.scope).toBe("instance");
    const policy = structuredClone(f.state.policy);
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
    f.resources.binding = "e".repeat(64);
    expect(await invoke(f, "prepareSignIn", { ...input, expectedBrokerRevision: f.state.revision }))
      .toEqual({ refused: "code_resources_changed" });
    expect(f.state.writes).toBe(1);
  });
});
