import { describe, expect, test } from "bun:test";
import { PluginRosterEntrySchema, ServiceReplySchema, type ServicePolicy } from "@manifold/protocol";
import { actionSchemas, CODE_PLUGIN_ID, GATEWAY_PLUGIN_ID, GATEWAY_OPERATION_ID, type ActionInput, type ActionResult, type CodeAction, type Target } from "../atyrode.code/contract.ts";
import { digestOf, type CodeContext } from "../atyrode.code/machine-server.ts";
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
  resources: { product: string; artifact: string; binding: string; installation: string; brokerRevision: string; policy: string };
  metadata: ProjectedBrokerSnapshot;
  holdTwoReads(): void;
  duringMetadata(hook: () => Promise<void>): void;
}

function fixture(isRoot = false): Fixture {
  const store = new Map<string, string>();
  const access = { containerScope: null as string | null, readable: new Set(["container-a", "container-b"]), writable: new Set(["container-a", "container-b"]) };
  const resources = { product: "a".repeat(64), artifact: "b".repeat(64), binding: "c".repeat(64), installation: "install-1", brokerRevision: "broker-1", policy: "d".repeat(64) };
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
        serviceId: "broker", revision: resources.brokerRevision, policySha256: resources.policy,
        operations: [{ operationId: "metadata", readable: true, invocable: false, ready: true, reason: null }],
      }] }),
      read: async args => {
        if (args.operationId !== "metadata" || args.serviceId !== "broker" || args.revision !== resources.brokerRevision || args.policySha256 !== resources.policy) return unavailable();
        const hook = onMetadata;
        onMetadata = undefined;
        await hook?.();
        return ServiceReplySchema.parse({ type: "service_result", requestId: "metadata-read", ok: true, result: structuredClone(metadata) });
      },
      invoke: unavailable, readConfiguration: unavailable, configureConfiguration: unavailable,
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
  test("account choices compile a concrete pool and native model routes without enabling disabled slots", async () => {
    const f = fixture();
    const record = await active(f);
    const accounts = await accepted(f, "accounts", target);
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
  ];
  for (const [name, slot, change] of accountChanges) {
    test(`fresh metadata cannot broaden a disabled reference after ${name}`, async () => {
      const f = fixture();
      const record = await active(f);
      const accounts = await accepted(f, "accounts", target);
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
  const accounts = await accepted(f, "accounts", target);
  const reference = accounts.accounts.find(account => account.credentialId === 1)!.reference;
  f.duringMetadata(async () => {
    await accepted(f, "changeAccounts", { ...target, expectedRevision: record.revision,
      change: { kind: "set-account", reference, enabled: false } });
  });
  expect(await invoke(f, "startInventory", { ...target, expectedRevision: record.revision }))
    .toEqual({ refused: "code_stale_preferences" });
  expect(started).toBe(0);
});

function keyEnrollmentFixture() {
  const f = fixture();
  const describe = f.ctx.services.describe;
  const admission = { ready: true, invocable: true };
  const writes: string[] = [];
  f.ctx.services.describe = async args => {
    const result = await describe(args);
    result.services[0]!.operations.push({ operationId: "enroll-key-openai", readable: false, ...admission, reason: null });
    return result;
  };
  f.ctx.services.invoke = async args => {
    if (args.machineId !== target.machineId || args.serviceId !== "broker" ||
      args.operationId !== "enroll-key-openai" || Object.keys(args.input).length !== 0 ||
      args.revision !== f.resources.brokerRevision || args.policySha256 !== f.resources.policy) return unavailable();
    writes.push(args.operationId);
    f.metadata.credentials.push({ id: 4, provider: "openai", identityKey: null, credential: { type: "api_key" } });
    return ServiceReplySchema.parse({ type: "service_result", requestId: "enroll-key", ok: true,
      result: { entries: [{ id: 4, provider: "openai", identityKey: null }] } });
  };
  return { ...f, admission, writes };
}

describe("native-reference API-key enrollment", () => {
  test("enrollment returns a fresh independent slot without changing saved exclusions", async () => {
    const f = keyEnrollmentFixture();
    await initialize(f);
    const accounts = await accepted(f, "accounts", target);
    const reference = accounts.accounts.find(account => account.credentialId === 2)!.reference;
    const original = await accepted(f, "changeAccounts", { ...target, expectedRevision: 1,
      change: { kind: "set-account", reference, enabled: false } });
    const result = await accepted(f, "enrollApiKey", { ...target, provider: "openai" });
    expect(result.status).toBe("fresh");
    expect(result.accounts.find(account => account.credentialId === 4)?.reference).toEqual({
      kind: "credential", scope: result.scope, provider: "openai", credentialId: 4,
    });
    expect(await configuration(f)).toEqual(original);
  });

  test("foreign targets and unconfigured or unready operations cannot enroll", async () => {
    const f = keyEnrollmentFixture();
    f.access.containerScope = target.containerId;
    expect(await invoke(f, "enrollApiKey", { ...target, containerId: "container-b", provider: "openai" }))
      .toEqual({ refused: "code_scope_refused" });
    f.access.writable.delete(target.containerId);
    expect(await invoke(f, "enrollApiKey", { ...target, provider: "openai" })).toEqual({ refused: "code_scope_refused" });
    f.access.writable.add(target.containerId);
    expect(await invoke(f, "enrollApiKey", { ...target, provider: "anthropic" }))
      .toEqual({ refused: "code_api_key_enrollment_unavailable" });
    f.admission.ready = false;
    expect(await invoke(f, "enrollApiKey", { ...target, provider: "openai" }))
      .toEqual({ refused: "code_api_key_enrollment_unavailable" });
    f.admission.ready = true; f.admission.invocable = false;
    expect(await invoke(f, "enrollApiKey", { ...target, provider: "openai" }))
      .toEqual({ refused: "code_api_key_enrollment_unavailable" });
    expect(f.writes).toEqual([]);
  });

  test("resource changes after enrollment never return accounts from a replacement broker policy", async () => {
    const f = keyEnrollmentFixture();
    const enroll = f.ctx.services.invoke;
    f.ctx.services.invoke = async args => {
      const response = await enroll(args);
      f.resources.policy = "e".repeat(64);
      return response;
    };
    expect(await invoke(f, "enrollApiKey", { ...target, provider: "openai" })).toEqual({ refused: "code_resources_changed" });
    expect(f.writes).toEqual(["enroll-key-openai"]);
  });

  test("unprojected secrets and another provider's entries are refused rather than echoed", async () => {
    const f = keyEnrollmentFixture();
    for (const entry of [
      { id: 4, provider: "openai", identityKey: null, credential: { type: "api_key", key: "do-not-disclose" } },
      { id: 4, provider: "anthropic", identityKey: null },
    ]) {
      f.ctx.services.invoke = async () => ServiceReplySchema.parse({ type: "service_result", requestId: "enroll-key", ok: true,
        result: { entries: [entry] } });
      expect(await invoke(f, "enrollApiKey", { ...target, provider: "openai" })).toEqual({ refused: "code_invalid_service_result" });
    }
  });
});

function ownerServiceFixture(isRoot = true) {
  const f = fixture(isRoot);
  const gateway = { runtime: { pluginId: GATEWAY_PLUGIN_ID, operationId: GATEWAY_OPERATION_ID,
    installationRevision: "gateway-install-1", artifactSha256: "7".repeat(64), resourceBindingDigest: "8".repeat(64) },
    ready: true, reason: null as string | null };
  const state = { revision: null as string | null, writes: 0, connected: true, gateway: gateway as typeof gateway | null,
    policies: [] as ServicePolicy[],
    references: [
      { ref: "broker-token", available: true, origins: ["https://broker.example"] },
      { ref: "openai-key", available: true, origins: ["https://broker.example"] },
    ] };
  const allows = f.ctx.auth.allows;
  f.ctx.auth.allows = async (cap, node) => (cap === "services:configure" && node?.kind === "machine" && node.machineId === target.machineId) || allows(cap, node);
  f.ctx.services.readConfiguration = async () => ({ configuration: { revision: state.revision, policies: state.policies },
    connected: state.connected, runtimeCandidates: state.gateway ? [state.gateway] : [], credentialReferences: state.references });
  f.ctx.services.configureConfiguration = async args => {
    if (args.expectedRevision !== state.revision) throw new Error("native revision conflict");
    state.writes++;
    state.policies = args.policies;
    state.revision = digestOf(state.policies);
    return { revision: state.revision, policies: state.policies };
  };
  const input: ActionInput<"reviewServices"> = { ...target, expectedServiceRevision: null,
    broker: { origin: "https://broker.example", credentialRef: "broker-token" }, classifier: null,
    apiKeys: [{ provider: "openai", credentialRef: "openai-key" }] };
  return { ...f, state, input };
}

describe("reviewed native API-key sources", () => {
  test("first use commits broker without a gateway, then binds an independently promoted ready installation", async () => {
    const f = ownerServiceFixture();
    const gateway = f.state.gateway!;
    f.state.gateway = null;
    const first = await accepted(f, "reviewServices", f.input);
    expect(first.gateway).toEqual({ status: "omitted", reason: "not_installed", nativeReason: null });
    const brokerOnly = await accepted(f, "configureServices", { ...f.input, reviewDigest: first.reviewDigest });
    expect(brokerOnly.policies.map(policy => policy.serviceId)).toEqual(["broker"]);
    expect(brokerOnly.policies[0]!.operations["enroll-key-openai"]).toBeDefined();

    f.state.gateway = gateway;
    const input = { ...f.input, expectedServiceRevision: brokerOnly.revision };
    const second = await accepted(f, "reviewServices", input);
    expect(second.gateway.status).toBe("ready");
    const complete = await accepted(f, "configureServices", { ...input, reviewDigest: second.reviewDigest });
    const runtime = complete.policies.find(policy => policy.serviceId === "omp")?.runtime;
    expect(runtime).toEqual({ ...gateway.runtime, input: { accountPool: { input: "accountPool" } } });
    expect(complete.policies.find(policy => policy.serviceId === "broker")).toEqual(brokerOnly.policies[0]);
    expect(f.state.writes).toBe(2);
  });

  test("an unavailable gateway removes stale omp only after a fresh explicit review", async () => {
    const f = ownerServiceFixture();
    const initial = await accepted(f, "reviewServices", f.input);
    const applied = await accepted(f, "configureServices", { ...f.input, reviewDigest: initial.reviewDigest });
    const input = { ...f.input, expectedServiceRevision: applied.revision };
    const ready = await accepted(f, "reviewServices", input);
    f.state.gateway = null;
    expect(await invoke(f, "configureServices", { ...input, reviewDigest: ready.reviewDigest }))
      .toEqual({ refused: "code_preview_changed" });
    expect(f.state.policies.some(policy => policy.serviceId === "omp")).toBe(true);
    const absent = await accepted(f, "reviewServices", input);
    expect(absent.gateway.status).toBe("omitted");
    const removed = await accepted(f, "configureServices", { ...input, reviewDigest: absent.reviewDigest });
    expect(removed.policies.map(policy => policy.serviceId)).toEqual(["broker"]);
  });

  test("unready native bindings omit runtime and becoming ready invalidates broker-only review", async () => {
    const f = ownerServiceFixture();
    f.state.gateway!.ready = false;
    f.state.gateway!.reason = "service_binding_changed";
    const unready = await accepted(f, "reviewServices", f.input);
    expect(unready.gateway).toEqual({ status: "omitted", reason: "resources_unready", nativeReason: "service_binding_changed" });
    expect(unready.policies.some(policy => policy.serviceId === "omp")).toBe(false);
    f.state.gateway!.ready = true;
    f.state.gateway!.reason = null;
    expect(await invoke(f, "configureServices", { ...f.input, reviewDigest: unready.reviewDigest }))
      .toEqual({ refused: "code_preview_changed" });
    expect(f.state.writes).toBe(0);
  });

  test("only ready native service candidates may become the model gateway", async () => {
    for (const reason of ["installation_disabled", "purge_requested", "installation_unavailable"] as const) {
      const f = ownerServiceFixture();
      f.state.gateway!.ready = false;
      f.state.gateway!.reason = reason;
      const review = await accepted(f, "reviewServices", f.input);
      expect(review.gateway).toEqual({ status: "omitted",
        reason: reason === "installation_unavailable" ? "resources_unready" : reason, nativeReason: reason });
      expect(review.policies.map(policy => policy.serviceId)).toEqual(["broker"]);
    }
    const disconnected = ownerServiceFixture();
    disconnected.state.connected = false;
    expect((await accepted(disconnected, "reviewServices", disconnected.input)).gateway)
      .toEqual({ status: "omitted", reason: "machine_disconnected", nativeReason: null });
  });

  test("gateway inspection cannot substitute a foreign installation and service setup retains root target authority", async () => {
    const f = ownerServiceFixture();
    f.state.gateway!.runtime.pluginId = CODE_PLUGIN_ID;
    expect((await accepted(f, "reviewServices", f.input)).gateway)
      .toEqual({ status: "omitted", reason: "not_installed", nativeReason: null });
    f.state.gateway!.runtime.pluginId = GATEWAY_PLUGIN_ID;
    const nonOwner = ownerServiceFixture(false);
    expect(await invoke(nonOwner, "reviewServices", nonOwner.input)).toEqual({ refused: "code_service_owner_required" });
    const review = await accepted(f, "reviewServices", f.input);
    f.access.writable.delete(target.containerId);
    expect(await invoke(f, "configureServices", { ...f.input, reviewDigest: review.reviewDigest }))
      .toEqual({ refused: "code_scope_refused" });
    expect(f.state.writes).toBe(0);
  });

  test("competing reviewed service writers cannot overwrite the winning native revision", async () => {
    const f = ownerServiceFixture();
    const review = await accepted(f, "reviewServices", f.input);
    const results = await Promise.allSettled([
      invoke(f, "configureServices", { ...f.input, reviewDigest: review.reviewDigest }),
      invoke(f, "configureServices", { ...f.input, reviewDigest: review.reviewDigest }),
    ]);
    expect(results.filter(result => result.status === "fulfilled" && actionSchemas.configureServices.result.safeParse(result.value).success)).toHaveLength(1);
    expect(f.state.writes).toBe(1);
  });

  test("every key source must remain available and origin-authorized at apply", async () => {
    const f = ownerServiceFixture();
    const review = await accepted(f, "reviewServices", f.input);
    f.state.references[1]!.available = false;
    expect(await invoke(f, "configureServices", { ...f.input, reviewDigest: review.reviewDigest }))
      .toEqual({ refused: "code_credential_reference_unavailable" });
    f.state.references[1]!.available = true;
    f.state.references[1]!.origins = ["https://elsewhere.example"];
    expect(await invoke(f, "reviewServices", f.input)).toEqual({ refused: "code_credential_reference_unavailable" });
    f.state.references.pop();
    expect(await invoke(f, "reviewServices", f.input)).toEqual({ refused: "code_credential_reference_unavailable" });
    expect(f.state.writes).toBe(0);
  });

  test("changed source, native revision and gateway binding invalidate reviewed authority", async () => {
    const f = ownerServiceFixture();
    const review = await accepted(f, "reviewServices", f.input);
    const originalBinding = f.state.gateway!.runtime.resourceBindingDigest;
    f.state.references.push({ ref: "other-key", available: true, origins: ["https://broker.example"] });
    expect(await invoke(f, "configureServices", { ...f.input, apiKeys: [{ provider: "openai", credentialRef: "other-key" }],
      reviewDigest: review.reviewDigest })).toEqual({ refused: "code_preview_changed" });
    f.state.revision = "a".repeat(64);
    expect(await invoke(f, "configureServices", { ...f.input, reviewDigest: review.reviewDigest }))
      .toEqual({ refused: "code_service_configuration_changed" });
    f.state.revision = null;
    f.state.gateway!.runtime.resourceBindingDigest = "e".repeat(64);
    expect(await invoke(f, "configureServices", { ...f.input, reviewDigest: review.reviewDigest }))
      .toEqual({ refused: "code_preview_changed" });
    f.state.gateway!.runtime.resourceBindingDigest = originalBinding;
    f.state.gateway!.runtime.installationRevision = "gateway-install-2";
    expect(await invoke(f, "configureServices", { ...f.input, reviewDigest: review.reviewDigest }))
      .toEqual({ refused: "code_preview_changed" });
    f.state.gateway!.runtime.installationRevision = "gateway-install-1";
    f.state.gateway!.runtime.artifactSha256 = "9".repeat(64);
    expect(await invoke(f, "configureServices", { ...f.input, reviewDigest: review.reviewDigest }))
      .toEqual({ refused: "code_preview_changed" });
    expect(f.state.writes).toBe(0);
  });
});
