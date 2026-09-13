import { describe, expect, test } from "bun:test";
import { ServiceConfigurationSchema, ServiceReplySchema, type ServiceConfiguration } from "@manifold/protocol";
import type { AccountsObservation, BenchmarkReceipt, InventoryReceipt } from "@atyrode/manifold-omp";
import { actionDoor, actionSchemas, createCodeClient, CODE_PLUGIN_ID,
  type ActionInput, type ActionResult, type CodeAction, type Configuration, type Target } from "../atyrode.code/contract.ts";
import { digestOf, type CodeContext } from "../atyrode.code/context.ts";
import { handlers } from "../atyrode.code/server.ts";
import { configurationMigration } from "../atyrode.code/state.ts";
import type { CatalogDocument } from "../domain/contracts.ts";
import { buildCodeServices } from "../atyrode.code/service-policies.ts";

const target: Target = { containerId: "container-a", machineId: "machine-a" };
const workspace = { containerId: target.containerId };
const now = Date.UTC(2026, 0, 1, 12);
const unavailable = async (): Promise<never> => { throw new Error("Unexpected native operation"); };
const classifier = { origin: "http://127.0.0.1:11434", model: "qwen3:8b" };

function document(): CatalogDocument {
  return { schemaVersion: 1, models: ([1, 2, 3] as const).map(tier => ({
    key: `model-${tier}`, provider: "anthropic", id: `native-model-${tier}`, api: "anthropic-messages", tier,
    quotaBucket: null, inputCostPerMillion: tier, outputCostPerMillion: tier * 3,
    tokensPerSecond: 30, timeToFirstTokenMs: 100, contextWindow: 200_000,
    thinkingLevels: ["minimal", "low", "medium", "high", "xhigh", "max"], images: true,
  })) };
}
function accounts(): AccountsObservation {
  const scope = "explicit-caller-observation";
  return { scope, observedAt: now, status: "fresh", accounts: [
    { reference: { kind: "identity", scope, provider: "anthropic", identityKey: "email:alice@example.test|org:original" },
      credentialId: 1, identityKey: "email:alice@example.test|org:original", type: "oauth", email: null, disabled: false, blocks: [] },
    ...[2, 3].map(credentialId => ({ reference: { kind: "credential" as const, scope, provider: "anthropic", credentialId },
      credentialId, identityKey: null, type: "api_key" as const, email: null, disabled: false, blocks: [] })),
  ] };
}

interface Fixture {
  ctx: CodeContext;
  access: { isRoot: boolean; containerScope: string | null; readable: Set<string>; writable: Set<string> };
  store: Map<string, string>;
  holdTwoReads(): void;
  afterNextRead(hook: () => Promise<void>): void;
}
function fixture(isRoot = false): Fixture {
  const store = new Map<string, string>();
  const access = { isRoot, containerScope: null as string | null,
    readable: new Set(["container-a", "container-b"]), writable: new Set(["container-a", "container-b"]) };
  let reads: { remaining: number; ready: Promise<void>; release: () => void } | undefined;
  let afterRead: (() => Promise<void>) | undefined;
  const ctx: CodeContext = {
    now: () => now,
    emit() {},
    outsideScope: async containerId => access.containerScope !== null && access.containerScope !== containerId ? { refused: "outside_scope" } : null,
    auth: {
      principal: { id: "writer", kind: "human", name: "Writer", color: "#123456" },
      caps: ["containers:read", "containers:write"], containerScope: null, get isRoot() { return access.isRoot; },
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
        const hook = afterRead;
        afterRead = undefined;
        await hook?.();
        return value;
      },
      set: unavailable, delete: unavailable, keys: unavailable,
      compareAndSet: async (key, expected, value) => {
        if ((store.get(key) ?? null) !== expected) return false;
        store.set(key, value);
        return true;
      },
    },
    services: {
      describe: unavailable, read: unavailable, invoke: unavailable,
      readConfiguration: unavailable, configureConfiguration: unavailable,
      describeInstance: unavailable, readInstance: unavailable, listInstances: unavailable,
      readInstanceConfiguration: unavailable, configureInstance: unavailable, invokeInstance: unavailable,
    },
  };
  return { ctx, access, store,
    holdTwoReads() {
      let release!: () => void;
      const ready = new Promise<void>(resolve => { release = resolve; });
      reads = { remaining: 2, ready, release };
    },
    afterNextRead(hook: () => Promise<void>) { afterRead = hook; },
  };
}
async function invoke<K extends CodeAction>(f: Fixture, name: K, input: ActionInput<K>): Promise<unknown> {
  return handlers[name]!(f.ctx, input);
}
async function accepted<K extends CodeAction>(f: Fixture, name: K, input: ActionInput<K>): Promise<ActionResult<K>> {
  return actionSchemas[name].result.parse(await invoke(f, name, input)) as ActionResult<K>;
}
async function initialize(f: Fixture, containerId = target.containerId) {
  return accepted(f, "initializeConfiguration", { containerId, expectedRevision: 0 });
}
async function staged(f: Fixture, catalog = document()) {
  await initialize(f);
  return accepted(f, "stageCatalog", { ...workspace, expectedRevision: 1, document: catalog });
}
async function active(f: Fixture) {
  const record = await staged(f);
  const review = await accepted(f, "reviewCatalog", { ...workspace, expectedRevision: record.revision, source: "draft" });
  return accepted(f, "promoteCatalog", { ...workspace, expectedRevision: record.revision, source: "draft", reviewDigest: review.reviewDigest });
}
async function configuration(f: Fixture, containerId = target.containerId) {
  return (await accepted(f, "readConfiguration", { containerId })).configuration;
}
function seedLegacy(f: Fixture, scope: Target, record: Configuration) {
  const key = `configuration/${digestOf(scope)}`;
  const raw = JSON.stringify({ ...record, ...scope, schemaVersion: 1, resources: { obsolete: "never authority" } });
  f.store.set(key, raw);
  return { key, raw };
}

describe("container-owned policy configuration", () => {
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

  test("destinations share a container profile while distinct containers remain isolated", async () => {
    const f = fixture();
    const first = await active(f);
    const isolated = await initialize(f, "container-b");
    const selected = await accepted(f, "select", { ...workspace, expectedRevision: first.revision,
      selection: { ...first.selection!, planYolo: true } });
    for (const machineId of ["machine-a", "machine-b"]) {
      expect(await accepted(f, "readConfiguration", { ...workspace, legacyMachineId: machineId }))
        .toEqual({ revision: selected.revision, configuration: selected, legacyMachineId: null });
    }
    expect((await accepted(f, "reviewCatalog", { ...workspace, expectedRevision: selected.revision, source: "active" })).review.selection.planYolo).toBe(true);
    expect(await configuration(f, "container-b")).toEqual(isolated);
  });

  test("schema2 reads project choices and revision without writing; the next CAS discards only runtime pins", async () => {
    const source = fixture();
    const original = await active(source);
    const chosen = await accepted(source, "changeAccounts", { ...workspace, expectedRevision: original.revision,
      change: { kind: "create-preset", preset: { id: "focus", name: "Focus", disabled: [accounts().accounts[0]!.reference] } } });
    const saved = await accepted(source, "changeAccounts", { ...workspace, expectedRevision: chosen.revision,
      change: { kind: "activate-preset", id: "focus" } });
    const f = fixture(), key = `configuration/${digestOf(workspace)}`;
    const raw = JSON.stringify({ ...saved, schemaVersion: 2, resourcesByMachine: { "machine-a": { retired: true }, "machine-b": null } });
    f.store.set(key, raw);
    expect(await configuration(f)).toEqual(saved);
    expect(f.store.get(key)).toBe(raw);
    const next = await accepted(f, "select", { ...workspace, expectedRevision: saved.revision,
      selection: { ...saved.selection!, prewalk: true } });
    expect(next).toEqual({ ...saved, revision: saved.revision + 1, selection: { ...saved.selection!, prewalk: true } });
    expect(JSON.parse(f.store.get(key)!)).toEqual(next);
    expect(await invoke(f, "changeAccounts", { ...workspace, expectedRevision: saved.revision,
      change: { kind: "delete-preset", id: "focus" } })).toEqual({ refused: "code_stale_preferences" });
    expect((await configuration(f))?.accounts).toEqual(saved.accounts);
  });

  test("native major migration transforms canonical schema2 records without changing policy revision or adopting schema1", async () => {
    const source = fixture(), original = await active(source);
    const saved = await accepted(source, "changeAccounts", { ...workspace, expectedRevision: original.revision,
      change: { kind: "set-account", reference: accounts().accounts[0]!.reference, enabled: false } });
    const f = fixture(), key = `configuration/${digestOf(workspace)}`;
    const current = await initialize(f, "container-b");
    f.store.set(key, JSON.stringify({ ...saved, schemaVersion: 2, resourcesByMachine: { "machine-a": { oldPin: true } } }));
    const legacy = seedLegacy(f, { containerId: "container-c", machineId: target.machineId }, { ...saved, containerId: "container-c" });
    f.store.set("other-data", "untouched");
    f.ctx.storage.keys = async prefix => [...f.store.keys()].filter(key => key.startsWith(prefix ?? ""));
    await configurationMigration.migrate(f.ctx.storage);
    expect(JSON.parse(f.store.get(key)!)).toEqual(saved);
    expect(await configuration(f, "container-b")).toEqual(current);
    expect(f.store.get(legacy.key)).toBe(legacy.raw);
    expect(f.store.has(`configuration/${digestOf({ containerId: "container-c" })}`)).toBe(false);
    expect(f.store.get("other-data")).toBe("untouched");
    const migrated = f.store.get(key);
    await configurationMigration.migrate(f.ctx.storage);
    expect(f.store.get(key)).toBe(migrated);
    const next = await accepted(f, "select", { ...workspace, expectedRevision: saved.revision,
      selection: { ...saved.selection!, planYolo: true } });
    expect(next.revision).toBe(saved.revision + 1);
    expect(next.accounts).toEqual(saved.accounts);
  });

  test("native migration refuses misbound container keys and cannot replace a concurrent CAS winner", async () => {
    const saved = await active(fixture()), f = fixture();
    const key = `configuration/${digestOf(workspace)}`;
    const raw = JSON.stringify({ ...saved, schemaVersion: 2, resourcesByMachine: {} });
    f.store.set(key, raw);
    f.ctx.storage.keys = async () => [key];
    const winner = { ...saved, revision: saved.revision + 1 };
    f.ctx.storage.compareAndSet = async () => { f.store.set(key, JSON.stringify(winner)); return false; };
    await expect(configurationMigration.migrate(f.ctx.storage)).rejects.toThrow("code_stale_preferences");
    expect(await configuration(f)).toEqual(winner);
    f.store.set(key, JSON.stringify({ ...saved, containerId: "container-b", schemaVersion: 2, resourcesByMachine: {} }));
    await expect(configurationMigration.migrate(f.ctx.storage)).rejects.toThrow("code_invalid_configuration");
  });

  test("legacy adoption is explicit and leaves every machine recovery record untouched", async () => {
    const source = fixture();
    const original = await active(source);
    const legacy = await accepted(source, "changeAccounts", { ...workspace, expectedRevision: original.revision,
      change: { kind: "set-account", reference: accounts().accounts[0]!.reference, enabled: false } });
    const f = fixture(), a = seedLegacy(f, target, legacy);
    const other = { ...target, machineId: "machine-b" };
    const b = seedLegacy(f, other, { ...original, revision: legacy.revision + 10, updatedAt: now + 10_000 });
    expect(await accepted(f, "readConfiguration", workspace)).toEqual({ revision: 0, configuration: null, legacyMachineId: null });
    expect(await accepted(f, "readConfiguration", { ...workspace, legacyMachineId: "missing" }))
      .toEqual({ revision: 0, configuration: null, legacyMachineId: null });
    const lookup = { ...workspace, legacyMachineId: target.machineId };
    expect(await accepted(f, "readConfiguration", lookup)).toEqual({ revision: legacy.revision, configuration: legacy, legacyMachineId: target.machineId });
    expect(await configuration(f)).toBeNull();
    const adopted = await accepted(f, "initializeConfiguration", { ...lookup, expectedRevision: legacy.revision });
    expect(adopted).toEqual({ ...legacy, revision: legacy.revision + 1 });
    expect(await accepted(f, "readConfiguration", { ...workspace, legacyMachineId: other.machineId }))
      .toEqual({ revision: adopted.revision, configuration: adopted, legacyMachineId: null });
    expect(await invoke(f, "initializeConfiguration", { ...workspace, legacyMachineId: other.machineId, expectedRevision: adopted.revision }))
      .toEqual({ refused: "code_stale_preferences" });
    expect(f.store.get(a.key)).toBe(a.raw);
    expect(f.store.get(b.key)).toBe(b.raw);
  });

  test("concurrent explicit legacy adopters cannot overwrite or merge the canonical winner", async () => {
    const f = fixture(), original = await active(fixture());
    const other = { ...target, machineId: "machine-b" };
    const alternate = { ...original, selection: { ...original.selection!, planYolo: !original.selection!.planYolo } };
    const records = [original, alternate], destinations = [target, other];
    const legacy = destinations.map((destination, index) => seedLegacy(f, destination, records[index]!));
    f.holdTwoReads();
    const results = await Promise.all(destinations.map(destination => invoke(f, "initializeConfiguration", {
      ...workspace, legacyMachineId: destination.machineId, expectedRevision: original.revision,
    })));
    const winnerIndex = results.findIndex(result => actionSchemas.initializeConfiguration.result.safeParse(result).success);
    expect(winnerIndex).not.toBe(-1);
    expect(results[1 - winnerIndex]).toEqual({ refused: "code_stale_preferences" });
    expect(await configuration(f)).toEqual({ ...records[winnerIndex]!, revision: original.revision + 1 });
    for (const saved of legacy) expect(f.store.get(saved.key)).toBe(saved.raw);
  });

  test("read-only authority can review policy but cannot mutate or disclose another container", async () => {
    const f = fixture(), original = await active(f);
    await initialize(f, "container-b");
    f.access.writable.clear();
    f.access.readable.delete("container-b");
    expect((await accepted(f, "reviewCatalog", { ...workspace, expectedRevision: original.revision, source: "active" })).review.selection).toEqual(original.selection!);
    expect(await invoke(f, "changeAccounts", { ...workspace, expectedRevision: original.revision,
      change: { kind: "create-preset", preset: { id: "forbidden", name: "Forbidden", disabled: [] } },
    })).toEqual({ refused: "code_scope_refused" });
    expect(await invoke(f, "readConfiguration", { containerId: "container-b" })).toEqual({ refused: "code_scope_refused" });
    f.access.readable.add("container-b");
    f.access.containerScope = "container-a";
    expect(await invoke(f, "readConfiguration", { containerId: "container-b" })).toEqual({ refused: "code_scope_refused" });
    expect(await configuration(f)).toEqual(original);
  });

  test("catalog promotion binds exact catalog bytes even if routes and revision match", async () => {
    const first = fixture(), second = fixture();
    await staged(first);
    const changed = document(); changed.models[0]!.contextWindow = 199_999;
    await staged(second, changed);
    const review = await accepted(first, "reviewCatalog", { ...workspace, expectedRevision: 2, source: "draft" });
    const other = await accepted(second, "reviewCatalog", { ...workspace, expectedRevision: 2, source: "draft" });
    expect(other.review.routes).toEqual(review.review.routes);
    expect(await invoke(second, "promoteCatalog", { ...workspace, expectedRevision: 2, source: "draft", reviewDigest: review.reviewDigest }))
      .toEqual({ refused: "code_preview_changed" });
    const promoted = await accepted(second, "promoteCatalog", { ...workspace, expectedRevision: 2, source: "draft", reviewDigest: other.reviewDigest });
    expect(promoted.active?.document).toEqual(changed);
    expect(promoted.draft).toBeNull();
    expect(await invoke(second, "promoteCatalog", { ...workspace, expectedRevision: 2, source: "draft", reviewDigest: other.reviewDigest }))
      .toEqual({ refused: "code_stale_preferences" });
  });
});

describe("pure client-supplied policy composition", () => {
  test("probe policy applies exact saved exclusions without an active catalog or native service authority", async () => {
    const f = fixture(); await initialize(f);
    const observation = accounts();
    const record = await accepted(f, "changeAccounts", { ...workspace, expectedRevision: 1,
      change: { kind: "set-account", reference: observation.accounts[1]!.reference, enabled: false } });
    expect(await accepted(f, "composeProbe", { ...workspace, expectedRevision: record.revision, accounts: observation }))
      .toEqual({ revision: record.revision, accountPool: { anthropic: [
        { scope: observation.scope, credentialId: 1, identityKey: observation.accounts[0]!.identityKey }, { scope: observation.scope, credentialId: 3, identityKey: null },
      ] } });
    observation.accounts[1]!.credentialId = 9;
    observation.accounts[1]!.reference = { kind: "credential", scope: observation.scope, provider: "anthropic", credentialId: 9 };
    expect(await invoke(f, "composeProbe", { ...workspace, expectedRevision: record.revision, accounts: observation }))
      .toEqual({ refused: "code_account_unavailable" });
  });

  test("session composition binds the prompt, exact account identities and Code revision without claiming native provenance", async () => {
    const f = fixture(), record = await active(f), observation = accounts();
    const input = { ...workspace, expectedRevision: record.revision, accounts: observation, prompt: "Implement the change" };
    const composed = await accepted(f, "composeSession", input);
    expect(composed.review.selection).toEqual(record.selection!);
    expect(composed.overlay.modelRoles?.default).toContain("anthropic/native-model-");
    expect(Object.keys(composed).sort()).toEqual(["accountPool", "compositionDigest", "overlay", "planYolo", "prompt", "review", "revision"]);
    expect(await accepted(f, "composeSession", input)).toEqual(composed);
    expect((await accepted(f, "composeSession", { ...input, prompt: "A different change" })).compositionDigest).not.toBe(composed.compositionDigest);
    observation.accounts[0]!.identityKey = "different-login";
    observation.accounts[0]!.reference = { ...observation.accounts[0]!.reference, kind: "identity", identityKey: "different-login" };
    expect((await accepted(f, "composeSession", input)).compositionDigest).not.toBe(composed.compositionDigest);
    const chosen = await accepted(f, "select", { ...workspace, expectedRevision: record.revision, selection: { ...record.selection!, planYolo: true } });
    expect(await invoke(f, "composeSession", input)).toEqual({ refused: "code_stale_preferences" });
    const current = await accepted(f, "composeSession", { ...input, expectedRevision: chosen.revision });
    expect(current.planYolo).toBe(true);
    expect(current.compositionDigest).not.toBe(composed.compositionDigest);
  });

  test("composition refuses choices committed during its configuration read", async () => {
    const f = fixture(), record = await active(f);
    f.afterNextRead(async () => {
      await accepted(f, "changeAccounts", { ...workspace, expectedRevision: record.revision,
        change: { kind: "set-account", reference: accounts().accounts[0]!.reference, enabled: false } });
    });
    expect(await invoke(f, "composeSession", { ...workspace, expectedRevision: record.revision, accounts: accounts(), prompt: "" }))
      .toEqual({ refused: "code_stale_preferences" });
  });

  test("freshness and complete route-provider coverage cannot be supplied by stale or empty pools", async () => {
    const f = fixture(), record = await active(f);
    const input = { ...workspace, expectedRevision: record.revision, prompt: "" };
    expect(await invoke(f, "composeSession", { ...input, accounts: { ...accounts(), status: "stale" } }))
      .toEqual({ refused: "code_account_unavailable" });
    expect(await invoke(f, "composeSession", { ...input, accounts: { ...accounts(), observedAt: now + 1 } }))
      .toEqual({ refused: "code_invalid_accounts" });
    expect(await invoke(f, "composeSession", { ...input, accounts: { ...accounts(), accounts: [] } }))
      .toEqual({ refused: "code_account_unavailable" });
  });

  test("inventory policy remains an unmeasured draft; deriving a catalog requires exact matching benchmark candidates", async () => {
    const f = fixture();
    const inventory: InventoryReceipt = { schemaVersion: 1, kind: "inventory", ompVersion: "18.1.14", observedAt: now,
      models: document().models.map(model => ({ provider: model.provider, id: model.id, api: model.api,
        inputCostPerMillion: model.inputCostPerMillion, outputCostPerMillion: model.outputCostPerMillion,
        contextWindow: model.tier * 200_000, maxTokens: 8192, reasoning: true,
        thinkingLevels: [(["low", "medium", "high"] as const)[model.tier - 1]!], images: model.images })) };
    const draft = await accepted(f, "draftInventory", { inventory });
    expect(draft.document.models.map(model => [model.tokensPerSecond, model.timeToFirstTokenMs])).toEqual([[null, null], [null, null], [null, null]]);
    const benchmark: BenchmarkReceipt = { schemaVersion: 1, kind: "benchmark", ompVersion: "18.1.14",
      inventoryObservedAt: now, startedAt: now, completedAt: now + 1,
      results: draft.benchmark.candidates.map(candidate => ({ ...candidate, status: "reachable", tokensPerSecond: 42, timeToFirstTokenMs: 80 })) };
    const catalog = await accepted(f, "deriveCatalog", { inventory, benchmark });
    expect(catalog.models.map(model => model.tokensPerSecond)).toEqual([42, 42, 42]);
    benchmark.results[0]!.api = "different-api";
    expect(await invoke(f, "deriveCatalog", { inventory, benchmark })).toEqual({ refused: "code_probe_missing_probe" });
    expect(await configuration(f)).toBeNull();
  });

  test("ordinary Code client rejects invalid requests and results while returning typed refusals", async () => {
    const f = fixture();
    const client = createCodeClient(async (door, input) => {
      const name = Object.keys(actionSchemas).find(name => actionDoor(name as CodeAction) === door)!;
      return handlers[name]!(f.ctx, input);
    });
    expect(await client.call("readConfiguration", workspace)).toEqual({ revision: 0, configuration: null, legacyMachineId: null });
    expect(await client.call("composeProbe", { ...workspace, expectedRevision: 0, accounts: accounts() })).toEqual({ refused: "code_configuration_missing" });
    await expect(client.call("initializeConfiguration", { ...workspace, expectedRevision: -1 })).rejects.toThrow();
    expect(await configuration(f)).toBeNull();
    await expect(createCodeClient(async () => ({ revision: 0 })).call("readConfiguration", workspace)).rejects.toThrow();
  });
});

function serviceFixture(isRoot = true) {
  const f = fixture(isRoot);
  const state = { configuration: { revision: null, policies: [] } as ServiceConfiguration, writes: 0, configureAllowed: true };
  const allows = f.ctx.auth.allows;
  f.ctx.auth.allows = async (cap, node) =>
    (state.configureAllowed && cap === "services:configure" && node?.kind === "machine" && node.machineId === target.machineId) || allows(cap, node);
  f.ctx.services.readConfiguration = async () => ({
    configuration: structuredClone(state.configuration), connected: true, credentialReferences: [], runtimeCandidates: [],
  });
  f.ctx.services.configureConfiguration = async args => {
    if (args.machineId !== target.machineId || args.expectedRevision !== state.configuration.revision) throw new Error("native service configuration conflict");
    state.configuration = ServiceConfigurationSchema.parse({ revision: digestOf(args.policies), policies: args.policies });
    state.writes++;
    return structuredClone(state.configuration);
  };
  return { ...f, state };
}
function suggestionFixture() {
  const f = fixture();
  const state = { revision: "classifier-1", policySha256: "d".repeat(64), calls: 0, duringInvoke: async () => {} };
  f.ctx.services.describe = async ({ machineId }) => ({ machineId, connected: true, services: [{
    serviceId: "suggest", revision: state.revision, policySha256: state.policySha256,
    operations: [{ operationId: "classify", readable: false, invocable: true, ready: true, reason: null }],
  }] });
  f.ctx.services.invoke = async args => {
    if (args.machineId !== target.machineId || args.serviceId !== "suggest" || args.operationId !== "classify" ||
      args.revision !== state.revision || args.policySha256 !== state.policySha256) return unavailable();
    state.calls++;
    await state.duringInvoke();
    return ServiceReplySchema.parse({ type: "service_result", requestId: "suggestion", ok: true,
      result: { message: { role: "assistant", content: 'hard — refactor\n{"model":"smart","thinking":"high","advisor":"review"}' }, done: true, model: "qwen3:8b" } });
  };
  return { ...f, state };
}

describe("Code external suggestion policy", () => {
  test("explicit classifier review preserves unrelated native policies and requires no worker candidates", async () => {
    const f = serviceFixture();
    const unrelated = { ...buildCodeServices({ classifier })[0]!, serviceId: "unrelated", revision: "existing" };
    f.state.configuration = { revision: "e".repeat(64), policies: [unrelated] };
    const input = { ...target, expectedServiceRevision: f.state.configuration.revision, classifier };
    const reviewed = await accepted(f, "reviewServices", input);
    expect(f.state.writes).toBe(0);
    const configured = await accepted(f, "configureServices", { ...input, reviewDigest: reviewed.reviewDigest });
    expect(configured.policies).toEqual([unrelated, ...buildCodeServices({ classifier })]);
    const removal = { ...target, expectedServiceRevision: configured.revision, classifier: null };
    const removed = await accepted(f, "reviewServices", removal);
    expect((await accepted(f, "configureServices", { ...removal, reviewDigest: removed.reviewDigest })).policies).toEqual([unrelated]);
    expect(await configuration(f)).toBeNull();
  });

  test("owner-only configuration rejects stale native CAS and altered reviewed classifier parameters", async () => {
    const input = { ...target, expectedServiceRevision: null, classifier };
    const nonOwner = serviceFixture(false);
    expect(await invoke(nonOwner, "readServiceConfiguration", target)).toEqual({ refused: "code_service_owner_required" });
    expect(await invoke(nonOwner, "reviewServices", input)).toEqual({ refused: "code_service_owner_required" });
    const f = serviceFixture(), reviewed = await accepted(f, "reviewServices", input);
    expect(await invoke(f, "configureServices", { ...input, classifier: { ...classifier, model: "different" }, reviewDigest: reviewed.reviewDigest }))
      .toEqual({ refused: "code_preview_changed" });
    f.access.writable.clear();
    expect(await invoke(f, "configureServices", { ...input, reviewDigest: reviewed.reviewDigest })).toEqual({ refused: "code_scope_refused" });
    f.access.writable.add(target.containerId);
    await f.ctx.services.configureConfiguration({ machineId: target.machineId, expectedRevision: null, policies: [] });
    expect(await invoke(f, "configureServices", { ...input, reviewDigest: reviewed.reviewDigest })).toEqual({ refused: "code_service_configuration_changed" });
    expect(f.state.writes).toBe(1);
  });

  test("invocation-only suggestion binds the reviewed classifier revision without saved runtime pins", async () => {
    const f = suggestionFixture(), record = await active(f);
    const input = { ...target, expectedRevision: record.revision, expectedServiceRevision: f.state.revision, prompt: "Refactor carefully" };
    f.state.revision = "classifier-2";
    expect(await invoke(f, "suggest", input)).toEqual({ refused: "code_service_configuration_changed" });
    expect(f.state.calls).toBe(0);
    const suggestion = await accepted(f, "suggest", { ...input, expectedServiceRevision: f.state.revision });
    expect(suggestion).toMatchObject({ revision: record.revision, serviceRevision: "classifier-2", selection: { capability: 3, thinking: "high", advisor: "review" } });
    expect(await configuration(f)).toEqual(record);
  });

  test("suggestion replies cannot outlive classifier revision changes or concurrent account choices", async () => {
    const f = suggestionFixture(), record = await active(f);
    const input = { ...target, expectedRevision: record.revision, expectedServiceRevision: f.state.revision, prompt: "Refactor" };
    f.state.duringInvoke = async () => { f.state.revision = "classifier-2"; };
    expect(await invoke(f, "suggest", input)).toEqual({ refused: "code_service_configuration_changed" });
    f.state.duringInvoke = async () => {
      await accepted(f, "changeAccounts", { ...workspace, expectedRevision: record.revision,
        change: { kind: "set-account", reference: accounts().accounts[0]!.reference, enabled: false } });
    };
    expect(await invoke(f, "suggest", { ...input, expectedServiceRevision: f.state.revision })).toEqual({ refused: "code_stale_preferences" });
  });
});
