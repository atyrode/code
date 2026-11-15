import { describe, expect, test } from "bun:test";
import { ServiceConfigurationSchema, ServiceReplySchema, type ServiceConfiguration } from "@manifold/protocol";
import { planDataMigration, type DataPlan } from "@manifold/plugin";
import { OMP_VERSION, type AccountsObservation, type BenchmarkReceipt, type InventoryReceipt, type ModelCatalogSnapshot } from "@atyrode/manifold-omp";
import { actionDoor, actionSchemas, createCodeClient, CODE_PLUGIN_ID,
  type ActionInput, type ActionResult, type CodeAction, type Configuration, type Target } from "../code/contract.ts";
import { digestOf, type CodeContext } from "../code/context.ts";
import plugin, { handlers } from "../code/server.ts";
import { configurationMigration } from "../code/state.ts";
import type { CatalogDocument, Selection } from "../domain/contracts.ts";
import { buildCodeServices } from "../code/service-policies.ts";

const target: Target = { containerId: "container-a", machineId: "machine-a" };
const workspace = { containerId: target.containerId };
const now = Date.UTC(2026, 0, 1, 12);
const unavailable = async (): Promise<never> => { throw new Error("Unexpected native operation"); };
const classifier = { origin: "http://127.0.0.1:11434", model: "qwen3:8b" };

// Three model families, not three versions: `native-model-1`..`-3` would be versions of one
// family, and derivation keeps only the newest version of a family.
function document(): CatalogDocument {
  return { schemaVersion: 1, models: ([1, 2, 3] as const).map(tier => ({
    key: `model-${tier}`, provider: "anthropic", id: `native-model${tier}`, api: "anthropic-messages", tier,
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
  /** OMP's current bundled model list, the only OMP door a configuration action reaches. */
  published: ModelCatalogSnapshot;
  /** How many times a door read that list. */
  publishedReads: number;
  holdTwoReads(): void;
  afterNextRead(hook: () => Promise<void>): void;
}
/** The bundled list OMP publishes for these models: what a launch may route to. */
function published(models: CatalogDocument["models"] = document().models): ModelCatalogSnapshot {
  return { schemaVersion: 1, source: "bundled", ompVersion: "18.1.14", revision: "a".repeat(64),
    models: models.map(model => ({ provider: model.provider, id: model.id, api: model.api, quotaTier: null,
      inputCostPerMillion: model.inputCostPerMillion, outputCostPerMillion: model.outputCostPerMillion, contextWindow: model.contextWindow,
      maxTokens: 64000, reasoning: true, thinkingLevels: model.thinkingLevels, images: model.images })) };
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
      set: unavailable, delete: async key => { store.delete(key); }, keys: async prefix => [...store.keys()].filter(key => key.startsWith(prefix ?? "")).sort(),
      compareAndSet: async (key, expected, value) => {
        // Plugin storage refuses a key outside this shape (plugin-kit `STORAGE_KEY_PATTERN`), so a write here does too.
        if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/.test(key)) throw new Error(`invalid storage key: ${key}`);
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
    // Session composition reads OMP's published model list and nothing else; any other door
    // a configuration action tried to reach would fail here by name.
    actions: { call: async ({ plugin, action, input }: { plugin: string; action: string; input: unknown }) => {
      if (plugin !== "atyrode.omp" || action !== "readModelCatalog") return unavailable();
      const { providers } = input as { providers: string[] };
      fixtureState.publishedReads++;
      return { ...fixtureState.published, models: fixtureState.published.models.filter(model => providers.includes(model.provider)) };
    } },
  };
  const fixtureState: Fixture = { ctx, access, store, published: published(), publishedReads: 0,
    holdTwoReads() {
      let release!: () => void;
      const ready = new Promise<void>(resolve => { release = resolve; });
      reads = { remaining: 2, ready, release };
    },
    afterNextRead(hook: () => Promise<void>) { afterRead = hook; },
  };
  return fixtureState;
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
/** A record as schema 3 stored it, before catalogs carried verification provenance. */
function version3(record: Configuration) {
  const unprovenanced = (catalog: Configuration["active"]) => catalog && { document: catalog.document, digest: catalog.digest };
  return { ...record, schemaVersion: 3, active: unprovenanced(record.active), draft: unprovenanced(record.draft) };
}
function seedLegacy(f: Fixture, scope: Target, record: Configuration) {
  const key = `configuration/${digestOf(scope)}`;
  const raw = JSON.stringify({ ...version3(record), ...scope, schemaVersion: 1, resources: { obsolete: "never authority" } });
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
    const raw = JSON.stringify({ ...version3(saved), schemaVersion: 2, resourcesByMachine: { "machine-a": { retired: true }, "machine-b": null } });
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

  test("the native v3 migration takes schema2 records to schema 3; reads answer schema 4 and the next CAS persists it", async () => {
    const source = fixture(), original = await active(source);
    const saved = await accepted(source, "changeAccounts", { ...workspace, expectedRevision: original.revision,
      change: { kind: "set-account", reference: accounts().accounts[0]!.reference, enabled: false } });
    const f = fixture(), key = `configuration/${digestOf(workspace)}`;
    const current = await initialize(f, "container-b");
    f.store.set(key, JSON.stringify({ ...version3(saved), schemaVersion: 2, resourcesByMachine: { "machine-a": { oldPin: true } } }));
    const legacy = seedLegacy(f, { containerId: "container-c", machineId: target.machineId }, { ...saved, containerId: "container-c" });
    f.store.set("other-data", "untouched");
    f.ctx.storage.keys = async prefix => [...f.store.keys()].filter(key => key.startsWith(prefix ?? ""));
    await configurationMigration.migrate(f.ctx.storage);
    expect(JSON.parse(f.store.get(key)!)).toEqual(version3(saved));
    // No bulk schema-4 pass exists: the read already answers schema 4, unverified.
    expect(await configuration(f)).toEqual(saved);
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
    expect(JSON.parse(f.store.get(key)!)).toEqual(next);
    expect(next.schemaVersion).toBe(4);
  });

  test("schema3 catalogs read as schema 4 unverified without a migration, and the next write persists schema 4", async () => {
    const source = fixture(), promoted = await active(source);
    const changed = document(); changed.models[0]!.contextWindow = 199_999;
    const saved = await accepted(source, "stageCatalog", { ...workspace, expectedRevision: promoted.revision, document: changed });
    expect([saved.active?.provenance, saved.draft?.provenance]).toEqual([null, null]);
    const f = fixture(), key = `configuration/${digestOf(workspace)}`, raw = JSON.stringify(version3(saved));
    f.store.set(key, raw);
    // A read answers schema 4 and writes nothing; the stored bytes stay schema 3 until a CAS.
    expect(await configuration(f)).toEqual(saved);
    expect(f.store.get(key)).toBe(raw);
    // The review of an unverified catalog says so, and promoting it persists schema 4 carrying that along.
    const review = await accepted(f, "reviewCatalog", { ...workspace, expectedRevision: saved.revision, source: "draft" });
    expect(review.provenance).toBeNull();
    const promotedNext = await accepted(f, "promoteCatalog", { ...workspace, expectedRevision: saved.revision, source: "draft", reviewDigest: review.reviewDigest });
    expect(promotedNext.active).toEqual({ document: changed, digest: digestOf(changed), provenance: null });
    expect(JSON.parse(f.store.get(key)!).schemaVersion).toBe(4);
  });

  test("the host plans only the v3 migration, and nothing from the current data version", () => {
    // Planning reads only names and targets, which is all that crosses the guest handshake.
    const migrations = plugin.migrations.map(({ name, to }) => ({ name, to, migrate() {} }));
    const plan = (stored: { major: number; minor: number }): DataPlan => planDataMigration({ pluginId: CODE_PLUGIN_ID,
      declared: plugin.manifest.dataVersion, stored, applied: new Set(), migrations });
    const names = (value: DataPlan) => value.kind === "migrate" ? value.run.map(migration => migration.name) : value.kind;
    expect(names(plan({ major: 2, minor: 1 }))).toBe("ok");
    expect(names(plan({ major: 1, minor: 0 }))).toEqual(["canonical-configuration-v3"]);
  });

  test("native migration refuses misbound container keys and cannot replace a concurrent CAS winner", async () => {
    const saved = await active(fixture()), f = fixture();
    const key = `configuration/${digestOf(workspace)}`;
    const older = (record: Configuration) => ({ ...version3(record), schemaVersion: 2, resourcesByMachine: {} });
    f.store.set(key, JSON.stringify(older(saved)));
    f.ctx.storage.keys = async () => [key];
    const winner = { ...saved, revision: saved.revision + 1 };
    f.ctx.storage.compareAndSet = async () => { f.store.set(key, JSON.stringify(winner)); return false; };
    await expect(configurationMigration.migrate(f.ctx.storage)).rejects.toThrow("code_stale_preferences");
    expect(await configuration(f)).toEqual(winner);
    f.store.set(key, JSON.stringify(older({ ...saved, containerId: "container-b" })));
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

  test("an explicit elite selection reviews and promotes a premium-only list without creating an automatic premium default", async () => {
    const f = fixture(), catalog: CatalogDocument = { schemaVersion: 1, models: [{ ...document().models[0]!,
      key: "astra", provider: "openai-codex", id: "gpt-6-astra", api: "openai-codex-responses", tier: 4 }] };
    const record = await staged(f, catalog);
    const input = { ...workspace, expectedRevision: record.revision, source: "draft" as const };
    const selection: Selection = { lane: { kind: "provider", family: "openai", blend: "only" }, capability: 4, thinking: "max", advisor: "off",
      spark: false, priority: false, prewalk: false, planYolo: false, fallback: true, budget: "any" };
    expect(await invoke(f, "reviewCatalog", input)).toEqual({ refused: "code_invalid_selection" });
    expect(await invoke(f, "reviewCatalog", { ...input, selection: { ...selection, capability: 2 } }))
      .toEqual({ refused: "code_invalid_selection" });
    const review = await accepted(f, "reviewCatalog", { ...input, selection });
    expect(review.review.selection).toEqual(selection);
    expect(review.review.routes.find(route => route.role === "default")?.lead).toEqual({ key: "astra", thinking: "max" });
    expect(await invoke(f, "promoteCatalog", { ...input, reviewDigest: review.reviewDigest }))
      .toEqual({ refused: "code_invalid_selection" });
    expect(await invoke(f, "promoteCatalog", { ...input, selection: { ...selection, capability: 2 }, reviewDigest: review.reviewDigest }))
      .toEqual({ refused: "code_invalid_selection" });
    expect(await invoke(f, "promoteCatalog", { ...input, selection: { ...selection, prewalk: true }, reviewDigest: review.reviewDigest }))
      .toEqual({ refused: "code_preview_changed" });
    expect(await configuration(f)).toEqual(record);
    const promoted = await accepted(f, "promoteCatalog", { ...input, selection, reviewDigest: review.reviewDigest });
    expect(promoted.revision).toBe(record.revision + 1);
    expect(promoted.selection).toEqual(selection);
    expect(promoted.active).toEqual(record.draft);
    expect(promoted.draft).toBeNull();
    expect((await accepted(f, "reviewCatalog", { ...workspace, expectedRevision: promoted.revision, source: "active" })).review.selection).toEqual(selection);
  });

  test("a new premium-only draft cannot turn a saved everyday selection into a different premium lead", async () => {
    const f = fixture(), original = await active(f);
    const catalog: CatalogDocument = { schemaVersion: 1, models: [{ ...document().models[0]!,
      key: "fable", id: "claude-fable-5-2", tier: 4 }] };
    const draft = await accepted(f, "stageCatalog", { ...workspace, expectedRevision: original.revision, document: catalog });
    const input = { ...workspace, expectedRevision: draft.revision, source: "draft" as const };
    expect(await invoke(f, "reviewCatalog", { ...input, selection: original.selection! })).toEqual({ refused: "code_invalid_selection" });
    const elite = { ...original.selection!, capability: 4 as const };
    const reviewed = await accepted(f, "reviewCatalog", { ...input, selection: elite });
    expect(await invoke(f, "promoteCatalog", { ...input, selection: original.selection!, reviewDigest: reviewed.reviewDigest }))
      .toEqual({ refused: "code_invalid_selection" });
    expect(await configuration(f)).toEqual(draft);
    const promoted = await accepted(f, "promoteCatalog", { ...input, selection: elite, reviewDigest: reviewed.reviewDigest });
    expect(promoted.selection).toEqual(elite);
    expect(promoted.active?.document).toEqual(catalog);
  });

  test("active review, promotion and selection cannot introduce an over-ceiling lead, but retain an already selected identity", async () => {
    const f = fixture(), catalog: CatalogDocument = { schemaVersion: 1, models: [...document().models,
      { ...document().models[0]!, key: "astra", provider: "openai-codex", id: "gpt-6-astra", tier: 4 }] };
    const draft = await staged(f, catalog);
    const reviewed = await accepted(f, "reviewCatalog", { ...workspace, expectedRevision: draft.revision, source: "draft" });
    const record = await accepted(f, "promoteCatalog", { ...workspace, expectedRevision: draft.revision, source: "draft", reviewDigest: reviewed.reviewDigest });
    const selection: Selection = { ...record.selection!, lane: { kind: "provider", family: "openai", blend: "only" }, capability: 2 };
    const input = { ...workspace, expectedRevision: record.revision };
    expect(await invoke(f, "select", { ...input, selection })).toEqual({ refused: "code_invalid_selection" });
    expect(await invoke(f, "reviewCatalog", { ...input, source: "active", selection })).toEqual({ refused: "code_invalid_selection" });
    expect(await invoke(f, "promoteCatalog", { ...input, source: "active", selection, reviewDigest: reviewed.reviewDigest }))
      .toEqual({ refused: "code_invalid_selection" });
    expect(await configuration(f)).toEqual(record);
    const elite = await accepted(f, "select", { ...input, selection: { ...selection, capability: 4 } });
    const legacy = await accepted(f, "select", { ...workspace, expectedRevision: elite.revision, selection });
    expect((await accepted(f, "reviewCatalog", { ...workspace, expectedRevision: legacy.revision, source: "active" })).review.selection).toEqual(selection);
  });

  test("a legacy over-ceiling lead survives metadata and key refreshes, never a provider or model identity change", async () => {
    for (const change of ["metadata", "provider", "id"] as const) {
      const f = fixture(), catalog: CatalogDocument = { schemaVersion: 1, models: [{ ...document().models[0]!,
        key: "astra", provider: "openai-codex", id: "gpt-6-astra", tier: 4 }] };
      const draft = await staged(f, catalog);
      const elite: Selection = { lane: { kind: "provider", family: "openai", blend: "only" }, capability: 4, thinking: "medium", advisor: "off",
        spark: false, priority: false, prewalk: false, planYolo: false, fallback: true, budget: "any" };
      const reviewed = await accepted(f, "reviewCatalog", { ...workspace, expectedRevision: draft.revision, source: "draft", selection: elite });
      const promoted = await accepted(f, "promoteCatalog", { ...workspace, expectedRevision: draft.revision, source: "draft", selection: elite, reviewDigest: reviewed.reviewDigest });
      const legacy = await accepted(f, "select", { ...workspace, expectedRevision: promoted.revision, selection: { ...elite, capability: 2 } });
      const refreshed: CatalogDocument = { schemaVersion: 1, models: [{ ...catalog.models[0]!, key: "refreshed-astra", contextWindow: 199_999,
        provider: change === "provider" ? "openai" : "openai-codex", id: change === "id" ? "gpt-6.1-astra" : "gpt-6-astra" }] };
      const stagedNext = await accepted(f, "stageCatalog", { ...workspace, expectedRevision: legacy.revision, document: refreshed });
      const input = { ...workspace, expectedRevision: stagedNext.revision, source: "draft" as const, selection: legacy.selection! };
      if (change !== "metadata") {
        expect(await invoke(f, "reviewCatalog", input)).toEqual({ refused: "code_invalid_selection" });
        expect(await configuration(f)).toEqual(stagedNext);
        continue;
      }
      const nextReview = await accepted(f, "reviewCatalog", input);
      const next = await accepted(f, "promoteCatalog", { ...input, reviewDigest: nextReview.reviewDigest });
      expect(next.selection).toEqual(legacy.selection);
      expect(next.active?.document).toEqual(refreshed);
    }
  });

  test("discarding a staged list clears it at the revision it was seen in, keeping the list in use and the team", async () => {
    const f = fixture(), promoted = await active(f);
    const changed = document(); changed.models[0]!.contextWindow = 199_999;
    const withDraft = await accepted(f, "stageCatalog", { ...workspace, expectedRevision: promoted.revision, document: changed });
    expect(await invoke(f, "discardCatalog", { ...workspace, expectedRevision: promoted.revision })).toEqual({ refused: "code_stale_preferences" });
    f.access.writable.clear();
    expect(await invoke(f, "discardCatalog", { ...workspace, expectedRevision: withDraft.revision })).toEqual({ refused: "code_scope_refused" });
    f.access.writable.add(target.containerId);
    const discarded = await accepted(f, "discardCatalog", { ...workspace, expectedRevision: withDraft.revision });
    expect(discarded).toMatchObject({ revision: withDraft.revision + 1, draft: null, active: promoted.active, selection: promoted.selection, accounts: promoted.accounts });
    expect(await invoke(f, "discardCatalog", { ...workspace, expectedRevision: discarded.revision })).toEqual({ refused: "code_catalog_missing" });
  });
});

describe("pure client-supplied policy composition", () => {
  test("probe policy applies exact saved exclusions without an active catalog or native service authority", async () => {
    const f = fixture(); await initialize(f);
    const observation = accounts();
    const record = await accepted(f, "changeAccounts", { ...workspace, expectedRevision: 1,
      change: { kind: "set-account", reference: observation.accounts[1]!.reference, enabled: false } });
    const probe = await accepted(f, "composeProbe", { ...workspace, expectedRevision: record.revision, accounts: observation });
    expect(probe).toEqual({ revision: record.revision, poolIdentityDigest: expect.stringMatching(/^[a-f0-9]{64}$/), accountPool: { anthropic: [
      { scope: observation.scope, credentialId: 1, identityKey: observation.accounts[0]!.identityKey }, { scope: observation.scope, credentialId: 3, identityKey: null },
    ] } });
    // The pool's identity is which slots serve it, not the order OMP happened to list them in.
    expect((await accepted(f, "composeProbe", { ...workspace, expectedRevision: record.revision,
      accounts: { ...observation, accounts: [...observation.accounts].reverse() } })).poolIdentityDigest).toBe(probe.poolIdentityDigest);
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
    expect(composed.overlay.modelRoles?.default).toContain("anthropic/native-model");
    expect(composed.overlay.task).toEqual({});
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

  test("composition maps deliberative effort without moving model tiers or propagating main effort to helpers", async () => {
    const f = fixture();
    let record = await active(f);
    const roles = ["default", "task", "plan", "slow", "advisor", "vision", "smol", "memory", "widget", "tiny", "commit"];
    for (const capability of [2, 3] as const) {
      for (const [thinking, deliberative] of [
        ["minimal", "minimal"], ["low", "medium"], ["medium", "high"],
        ["high", "xhigh"], ["xhigh", "xhigh"], ["max", "max"],
      ] as const) {
        record = await accepted(f, "select", { ...workspace, expectedRevision: record.revision,
          selection: { ...record.selection!, capability, thinking, advisor: "glance", prewalk: true, fallback: true } });
        const composed = await accepted(f, "composeSession", { ...workspace, expectedRevision: record.revision, accounts: accounts(), prompt: "" });
        expect(composed.review.selection.thinking).toBe(thinking);
        expect(composed.review.routes.map(route => route.role)).toEqual(roles);
        expect(Object.keys(composed.overlay.modelRoles!)).toEqual(roles);
        expect(Object.keys(composed.overlay.retry!.fallbackChains!)).toEqual(roles);
        expect(composed.overlay.task).toEqual({ prewalk: true });
        expect(Object.hasOwn(composed.overlay, "memory")).toBe(false);
        expect(composed.overlay.modelRoles).toEqual({
          default: `anthropic/native-model${capability}:${thinking}`, task: `anthropic/native-model${capability}:${thinking}`,
          plan: `anthropic/native-model${capability}:${deliberative}`, slow: `anthropic/native-model${capability}:${deliberative}`,
          advisor: "anthropic/native-model1:low", vision: `anthropic/native-model${capability}:low`,
          smol: "anthropic/native-model1:medium", memory: "anthropic/native-model1:medium", widget: "anthropic/native-model1:low",
          tiny: "anthropic/native-model1:low", commit: "anthropic/native-model1:low",
        });
        for (const role of ["plan", "slow"])
          expect(composed.overlay.retry!.fallbackChains![role]).toEqual(capability === 2
            ? [`anthropic/native-model1:${deliberative}`]
            : [`anthropic/native-model2:${deliberative}`, `anthropic/native-model1:${deliberative}`]);
        for (const role of ["default", "task"])
          expect(composed.overlay.retry!.fallbackChains![role]).toEqual(capability === 2
            ? [`anthropic/native-model1:${thinking}`]
            : [`anthropic/native-model2:${thinking}`, `anthropic/native-model1:${thinking}`]);
        for (const role of ["advisor", "smol", "memory", "widget", "tiny", "commit"])
          expect(composed.overlay.retry!.fallbackChains![role]).toEqual([]);
      }
    }

    record = await accepted(f, "select", { ...workspace, expectedRevision: record.revision, selection: { ...record.selection!, advisor: "off" } });
    const off = await accepted(f, "composeSession", { ...workspace, expectedRevision: record.revision, accounts: accounts(), prompt: "" });
    expect(Object.keys(off.overlay.modelRoles!)).toEqual(roles.filter(role => role !== "advisor"));
    expect(Object.keys(off.overlay.retry!.fallbackChains!)).toEqual(roles.filter(role => role !== "advisor"));
    expect(off.overlay.advisor).toEqual({ enabled: false });
    record = await accepted(f, "select", { ...workspace, expectedRevision: record.revision, selection: { ...record.selection!, fallback: false } });
    const noFallback = await accepted(f, "composeSession", { ...workspace, expectedRevision: record.revision, accounts: accounts(), prompt: "" });
    expect(noFallback.overlay.retry?.modelFallback).toBe(false);
    expect(noFallback.overlay.retry?.fallbackChains?.memory).toEqual([]);
    expect(Object.hasOwn(noFallback.overlay, "memory")).toBe(false);
    expect(noFallback.overlay.task).toEqual({ prewalk: true });
  });

  test("composition clamps mapped effort independently for each model, never rounding xhigh up to max", async () => {
    const f = fixture(), catalog = document();
    catalog.models[0]!.thinkingLevels = ["low", "medium"];
    catalog.models[1]!.thinkingLevels = ["low", "medium", "high", "max"];
    f.published = published(catalog.models);
    const draft = await staged(f, catalog);
    const review = await accepted(f, "reviewCatalog", { ...workspace, expectedRevision: draft.revision, source: "draft" });
    let record = await accepted(f, "promoteCatalog", { ...workspace, expectedRevision: draft.revision, source: "draft", reviewDigest: review.reviewDigest });
    for (const [thinking, main, deliberative, fallback] of [
      ["minimal", "low", "low", "low"], ["low", "low", "medium", "medium"], ["medium", "medium", "high", "medium"],
      ["high", "high", "high", "medium"], ["xhigh", "high", "high", "medium"], ["max", "max", "max", "medium"],
    ] as const) {
      record = await accepted(f, "select", { ...workspace, expectedRevision: record.revision,
        selection: { ...record.selection!, capability: 2, thinking, advisor: "glance", fallback: true } });
      const composed = await accepted(f, "composeSession", { ...workspace, expectedRevision: record.revision, accounts: accounts(), prompt: "" });
      expect(composed.review.selection.thinking).toBe(thinking);
      expect(composed.overlay.modelRoles).toEqual({
        default: `anthropic/native-model2:${main}`, task: `anthropic/native-model2:${main}`,
        plan: `anthropic/native-model2:${deliberative}`, slow: `anthropic/native-model2:${deliberative}`,
        advisor: "anthropic/native-model1:low", vision: "anthropic/native-model2:low",
        smol: "anthropic/native-model1:medium", memory: "anthropic/native-model1:medium", widget: "anthropic/native-model1:low",
        tiny: "anthropic/native-model1:low", commit: "anthropic/native-model1:low",
      });
      for (const role of ["plan", "slow"])
        expect(composed.overlay.retry!.fallbackChains![role]).toEqual([`anthropic/native-model1:${fallback}`]);
      expect(composed.overlay.retry!.fallbackChains!.memory).toEqual([]);
      expect(composed.overlay.retry!.fallbackChains!.widget).toEqual([]);
      expect(composed.overlay.task).toEqual({});
      expect(Object.hasOwn(composed.overlay, "memory")).toBe(false);
    }
  });

  test("advisor intensity keeps its own model and effort when the main effort is max", async () => {
    const f = fixture();
    let record = await active(f);
    for (const [advisor, lead, fallback] of [
      ["glance", "anthropic/native-model1:low", []],
      ["review", "anthropic/native-model2:medium", ["anthropic/native-model1:low"]],
      ["audit", "anthropic/native-model3:high", ["anthropic/native-model2:high", "anthropic/native-model1:low"]],
    ] as const) {
      record = await accepted(f, "select", { ...workspace, expectedRevision: record.revision,
        selection: { ...record.selection!, capability: 2, thinking: "max", advisor, fallback: true } });
      const composed = await accepted(f, "composeSession", { ...workspace, expectedRevision: record.revision, accounts: accounts(), prompt: "" });
      expect(composed.overlay.modelRoles?.advisor).toBe(lead);
      expect(composed.overlay.retry?.fallbackChains?.advisor).toEqual([...fallback]);
      expect(composed.overlay.modelRoles?.plan).toBe("anthropic/native-model2:max");
      expect(composed.overlay.modelRoles?.slow).toBe("anthropic/native-model2:max");
    }
  });

  test("a free profile composes routine work without promoting to a paid premium rung, but refuses that explicit rung", async () => {
    const f = fixture(), catalog = document();
    for (const model of catalog.models.filter(model => model.tier < 3)) {
      model.inputCostPerMillion = 0;
      model.outputCostPerMillion = 0;
    }
    const draft = await staged(f, catalog);
    const review = await accepted(f, "reviewCatalog", { ...workspace, expectedRevision: draft.revision, source: "draft" });
    const promoted = await accepted(f, "promoteCatalog", { ...workspace, expectedRevision: draft.revision, source: "draft", reviewDigest: review.reviewDigest });
    const selection = { ...promoted.selection!, capability: 2 as const, budget: "free" as const };
    const saved = await accepted(f, "select", { ...workspace, expectedRevision: promoted.revision, selection });
    const composed = await accepted(f, "composeSession", { ...workspace, expectedRevision: saved.revision, accounts: accounts(), prompt: "" });
    expect(composed.overlay.modelRoles?.slow).toBe("anthropic/native-model2:high");
    expect(Object.values(composed.overlay.modelRoles!).some(reference => reference.includes("native-model3"))).toBe(false);
    expect(Object.values(composed.overlay.retry!.fallbackChains!).flat().some(reference => reference.includes("native-model3"))).toBe(false);
    expect(await invoke(f, "select", { ...workspace, expectedRevision: saved.revision, selection: { ...selection, capability: 3 } }))
      .toEqual({ refused: "code_budget_unsatisfiable" });
    expect(await configuration(f)).toEqual(saved);
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

  const anthropicSmart: Selection = { lane: { kind: "provider", family: "anthropic", blend: "only" }, capability: 3, thinking: "medium", advisor: "off",
    spark: false, priority: false, prewalk: false, planYolo: false, fallback: true, budget: "any" };
  const leadOf = (composed: ActionResult<"composeSession">) => composed.review.routes.find(route => route.role === "default")?.lead.key;
  /** A list put in use at `selection`, then its record as an older Code saved it: the same bytes, at the rank `stored`. */
  async function storedChoice(f: Fixture, catalog: CatalogDocument, selection: Selection, stored: Selection): Promise<Configuration> {
    const draft = await staged(f, catalog);
    const input = { ...workspace, expectedRevision: draft.revision, source: "draft" as const, selection };
    const review = await accepted(f, "reviewCatalog", input);
    const record = { ...await accepted(f, "promoteCatalog", { ...input, reviewDigest: review.reviewDigest }), selection: stored };
    f.store.set(`configuration/${digestOf(workspace)}`, JSON.stringify(record));
    return record;
  }

  test("composition admits a saved premium lead as selection does, before reading OMP: an authored legacy identity composes, a rank its named tier moved does not", async () => {
    // Fable stored at its own elite tier, chosen there, then kept at normal: the same authored model keeps its meaning.
    const authored = fixture(), fable: CatalogDocument = { schemaVersion: 1, models: [{ ...document().models[0]!, key: "fable", id: "claude-fable-5-2", tier: 4 }] };
    authored.published = published(fable.models);
    const elite = await storedChoice(authored, fable, { ...anthropicSmart, capability: 4 }, { ...anthropicSmart, capability: 4 });
    const kept = await accepted(authored, "select", { ...workspace, expectedRevision: elite.revision, selection: { ...anthropicSmart, capability: 2 } });
    expect(leadOf(await accepted(authored, "composeSession", { ...workspace, expectedRevision: kept.revision, accounts: accounts(), prompt: "" }))).toBe("fable");
    // A lone Opus a price ladder stored at fast, saved at fast or normal: that rank was never a choice of a smart model.
    for (const capability of [1, 2] as const) {
      const f = fixture(), opus: CatalogDocument = { schemaVersion: 1, models: [{ ...document().models[0]!, key: "opus", id: "claude-opus-5", tier: 1 }] };
      f.published = published(opus.models);
      const legacy = await storedChoice(f, opus, anthropicSmart, { ...anthropicSmart, capability });
      const before = [...f.store];
      expect(await invoke(f, "composeSession", { ...workspace, expectedRevision: legacy.revision, accounts: accounts(), prompt: "" }))
        .toEqual({ refused: "code_invalid_selection" });
      expect([f.publishedReads, [...f.store]]).toEqual([0, before]);
      expect(await configuration(f)).toEqual(legacy);
      // Its actual tier, chosen explicitly, composes the same stored model; the stored list is untouched.
      const chosen = await accepted(f, "select", { ...workspace, expectedRevision: legacy.revision, selection: anthropicSmart });
      expect(leadOf(await accepted(f, "composeSession", { ...workspace, expectedRevision: chosen.revision, accounts: accounts(), prompt: "" }))).toBe("opus");
      expect([chosen.active, f.publishedReads]).toEqual([legacy.active, 1]);
      // Once its actual tier is saved, going back under it is still no premium consent: refused, nothing written, and the
      // saved actual tier composes as before.
      const saved = [...f.store];
      expect(await invoke(f, "select", { ...workspace, expectedRevision: chosen.revision, selection: { ...anthropicSmart, capability } }))
        .toEqual({ refused: "code_invalid_selection" });
      expect([...f.store]).toEqual(saved);
      expect(await configuration(f)).toEqual(chosen);
      expect(leadOf(await accepted(f, "composeSession", { ...workspace, expectedRevision: chosen.revision, accounts: accounts(), prompt: "" }))).toBe("opus");
      expect(f.publishedReads).toBe(2);
    }
  });

  test("a stored rank whose model the named tiers would change composes nothing until chosen explicitly, and an explicit choice resolves the canonical model", async () => {
    // Haiku and Opus a price ladder stored at fast and normal, saved at normal, which meant Opus: read by name, normal is Haiku's.
    const f = fixture(), base = document().models;
    const catalog: CatalogDocument = { schemaVersion: 1, models: [{ ...base[0]!, key: "haiku", id: "claude-haiku-5", tier: 1 },
      { ...base[1]!, key: "opus", id: "claude-opus-5", tier: 2 }] };
    f.published = published(catalog.models);
    const legacy = await storedChoice(f, catalog, anthropicSmart, { ...anthropicSmart, capability: 2 });
    const before = [...f.store];
    expect(await invoke(f, "composeSession", { ...workspace, expectedRevision: legacy.revision, accounts: accounts(), prompt: "" }))
      .toEqual({ refused: "code_invalid_selection" });
    expect(await invoke(f, "reviewCatalog", { ...workspace, expectedRevision: legacy.revision, source: "active" })).toEqual({ refused: "code_invalid_selection" });
    expect([f.publishedReads, [...f.store]]).toEqual([0, before]);
    expect(await configuration(f)).toEqual(legacy);
    for (const [capability, key] of [[1, "haiku"], [2, "haiku"], [3, "opus"]] as const) {
      const review = await accepted(f, "reviewCatalog", { ...workspace, expectedRevision: legacy.revision, source: "active", selection: { ...anthropicSmart, capability } });
      expect(review.review.routes.find(route => route.role === "default")?.lead.key).toBe(key);
    }
    // The same rank chosen again is a choice of what it now names, never of the model it once meant.
    const normal = await accepted(f, "select", { ...workspace, expectedRevision: legacy.revision, selection: legacy.selection! });
    expect(leadOf(await accepted(f, "composeSession", { ...workspace, expectedRevision: normal.revision, accounts: accounts(), prompt: "" }))).toBe("haiku");
    const chosen = await accepted(f, "select", { ...workspace, expectedRevision: normal.revision, selection: anthropicSmart });
    expect(leadOf(await accepted(f, "composeSession", { ...workspace, expectedRevision: chosen.revision, accounts: accounts(), prompt: "" }))).toBe("opus");
    expect([normal.active, chosen.active]).toEqual([legacy.active, legacy.active]);
  });

  describe("the private resolved intent of an explicit choice", () => {
    // Sonnet and Opus a price ladder stored at elite and smart, saved at normal, which meant Opus: read by name,
    // Sonnet is normal and Opus smart, so the saved rank alone cannot say which model it chose.
    const base = document().models;
    const compressed: CatalogDocument = { schemaVersion: 1, models: [{ ...base[1]!, key: "sonnet", id: "claude-sonnet-5", tier: 4 },
      { ...base[2]!, key: "opus", id: "claude-opus-5", tier: 3 }] };
    const normal: Selection = { ...anthropicSmart, capability: 2 };
    const key = `configuration/${digestOf(workspace)}`;
    const envelope = (f: Fixture) => JSON.parse(f.store.get(key)!) as Record<string, unknown>;
    const compose = (f: Fixture, expectedRevision: number) => invoke(f, "composeSession", { ...workspace, expectedRevision, accounts: accounts(), prompt: "" });
    const profile = async (f: Fixture) => (await accepted(f, "listProfiles", {})).profiles.find(row => row.containerId === workspace.containerId);
    async function legacyOf(f: Fixture) {
      f.published = published(compressed.models);
      return storedChoice(f, compressed, anthropicSmart, normal);
    }

    test("a deliberate same-rank choice writes its witness in the one CAS, and reads, listing and composition then resolve it without any public field", async () => {
      const f = fixture(), legacy = await legacyOf(f);
      // Unwitnessed, the saved rank composes nothing and lists no model, before OMP is read; the record still reads and lists.
      expect(await compose(f, legacy.revision)).toEqual({ refused: "code_invalid_selection" });
      expect(await invoke(f, "reviewCatalog", { ...workspace, expectedRevision: legacy.revision, source: "active" })).toEqual({ refused: "code_invalid_selection" });
      expect(await profile(f)).toMatchObject({ revision: legacy.revision, selected: null });
      expect(f.publishedReads).toBe(0);
      // A caller cannot supply a witness: the published input grammar has no place for one.
      expect(await invoke(f, "select", { ...workspace, expectedRevision: legacy.revision, selection: normal,
        resolvedSelection: { catalogDigest: legacy.active!.digest, selectionDigest: digestOf(normal), provider: "anthropic", id: "claude-opus-5" } } as never))
        .toEqual({ refused: "code_invalid_request" });
      const writes = f.store.size;
      const saved = await accepted(f, "select", { ...workspace, expectedRevision: legacy.revision, selection: normal });
      expect(saved).toEqual({ ...legacy, revision: legacy.revision + 1, updatedAt: now });
      expect(f.store.size).toBe(writes);
      expect(envelope(f)).toEqual({ ...saved, resolvedSelection: { catalogDigest: legacy.active!.digest, selectionDigest: digestOf(normal),
        provider: "anthropic", id: "claude-sonnet-5" } });
      // Every public answer is the strict record: `accepted` parses each through its published schema.
      expect(await configuration(f)).toEqual(saved);
      expect(Object.keys((await accepted(f, "readConfiguration", workspace)).configuration!)).not.toContain("resolvedSelection");
      const reviewed = await accepted(f, "reviewCatalog", { ...workspace, expectedRevision: saved.revision, source: "active" });
      expect(reviewed.review.routes.find(route => route.role === "default")?.lead.key).toBe("sonnet");
      expect(await profile(f)).toMatchObject({ selected: { model: "anthropic/claude-sonnet-5", capability: 2 } });
      expect(leadOf(await accepted(f, "composeSession", { ...workspace, expectedRevision: saved.revision, accounts: accounts(), prompt: "" }))).toBe("sonnet");
      // The raw list, its digest and its provenance are exactly the ones saved before.
      expect(saved.active).toEqual(legacy.active);
      expect(saved.active!.digest).toBe(digestOf(compressed));
    });

    test("a malformed, stale or mismatched witness is no witness: reads keep working and keep its bytes, composition refuses", async () => {
      const f = fixture(), legacy = await legacyOf(f);
      const saved = await accepted(f, "select", { ...workspace, expectedRevision: legacy.revision, selection: normal });
      const valid = envelope(f).resolvedSelection as Record<string, string>;
      for (const witness of [{ ...valid, provider: 7 }, "sonnet", null, { ...valid, extra: true },
        { ...valid, catalogDigest: "0".repeat(64) }, { ...valid, selectionDigest: digestOf({ ...normal, thinking: "high" }) },
        { ...valid, id: "claude-opus-5" }, { ...valid, provider: "openai" }]) {
        const raw = JSON.stringify({ ...saved, resolvedSelection: witness });
        f.store.set(key, raw);
        expect(await configuration(f)).toEqual(saved);
        expect(await profile(f)).toMatchObject({ revision: saved.revision, selected: null });
        expect(await invoke(f, "reviewCatalog", { ...workspace, expectedRevision: saved.revision, source: "active" })).toEqual({ refused: "code_invalid_selection" });
        expect(await compose(f, saved.revision)).toEqual({ refused: "code_invalid_selection" });
        expect(f.store.get(key)).toBe(raw);
      }
      expect(f.publishedReads).toBe(0);
      // An unrelated write drops what no longer binds rather than carrying it.
      const changed = await accepted(f, "changeAccounts", { ...workspace, expectedRevision: saved.revision,
        change: { kind: "set-account", reference: accounts().accounts[2]!.reference, enabled: false } });
      expect(envelope(f)).toEqual(changed);
    });

    test("unrelated writes carry a still-bound witness; a new explicit choice rebinds it and an automatic one never creates it", async () => {
      const f = fixture(), legacy = await legacyOf(f);
      const saved = await accepted(f, "select", { ...workspace, expectedRevision: legacy.revision, selection: normal });
      const witness = envelope(f).resolvedSelection;
      const refreshed = { ...compressed, models: compressed.models.map(model => ({ ...model, contextWindow: 199_999 })) };
      const stagedNext = await accepted(f, "stageCatalog", { ...workspace, expectedRevision: saved.revision, document: refreshed });
      const changed = await accepted(f, "changeAccounts", { ...workspace, expectedRevision: stagedNext.revision,
        change: { kind: "set-account", reference: accounts().accounts[2]!.reference, enabled: false } });
      const discarded = await accepted(f, "discardCatalog", { ...workspace, expectedRevision: changed.revision });
      expect(envelope(f)).toEqual({ ...discarded, resolvedSelection: witness });
      // Re-saving the list in use with no new choice carries the same witness.
      const kept = await accepted(f, "reviewCatalog", { ...workspace, expectedRevision: discarded.revision, source: "active" });
      const repromoted = await accepted(f, "promoteCatalog", { ...workspace, expectedRevision: discarded.revision, source: "active", reviewDigest: kept.reviewDigest });
      expect(envelope(f)).toEqual({ ...repromoted, resolvedSelection: witness });
      expect(leadOf(await accepted(f, "composeSession", { ...workspace, expectedRevision: repromoted.revision, accounts: accounts(), prompt: "" }))).toBe("sonnet");
      // A changed selector is a new choice: the server rebinds the witness to the model it now names.
      const smart = await accepted(f, "select", { ...workspace, expectedRevision: repromoted.revision, selection: anthropicSmart });
      expect(envelope(f).resolvedSelection).toEqual({ catalogDigest: legacy.active!.digest, selectionDigest: digestOf(anthropicSmart),
        provider: "anthropic", id: "claude-opus-5" });
      // A new list promoted with no choice of its own keeps no witness, even over a witnessed saved choice.
      const draft = await accepted(f, "stageCatalog", { ...workspace, expectedRevision: smart.revision, document: document() });
      const automatic = await accepted(f, "reviewCatalog", { ...workspace, expectedRevision: draft.revision, source: "draft" });
      const promoted = await accepted(f, "promoteCatalog", { ...workspace, expectedRevision: draft.revision, source: "draft", reviewDigest: automatic.reviewDigest });
      expect(envelope(f)).toEqual(promoted);
      // The same list chosen explicitly at review and promotion is witnessed in that promotion's CAS.
      const again = await accepted(f, "stageCatalog", { ...workspace, expectedRevision: promoted.revision, document: compressed });
      const input = { ...workspace, expectedRevision: again.revision, source: "draft" as const, selection: normal };
      const explicit = await accepted(f, "reviewCatalog", input);
      const chosen = await accepted(f, "promoteCatalog", { ...input, reviewDigest: explicit.reviewDigest });
      expect(envelope(f)).toEqual({ ...chosen, resolvedSelection: witness });
    });
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
    const inventory: InventoryReceipt = { schemaVersion: 1, kind: "inventory", ompVersion: OMP_VERSION, observedAt: now,
      models: document().models.map(model => ({ provider: model.provider, id: model.id, api: model.api,
        inputCostPerMillion: model.inputCostPerMillion, outputCostPerMillion: model.outputCostPerMillion,
        contextWindow: model.tier * 200_000, maxTokens: 8192, reasoning: true,
        thinkingLevels: [(["low", "medium", "high"] as const)[model.tier - 1]!], images: model.images, quotaTier: null })) };
    const draft = await accepted(f, "draftInventory", { inventory, budget: "any" });
    // The charge, and nothing a caller could stage before a single model was probed.
    expect("document" in draft).toBe(false);
    expect(draft.benchmark.candidates.map(candidate => candidate.id)).toEqual(["native-model1", "native-model2", "native-model3"]);
    const benchmark: BenchmarkReceipt = { schemaVersion: 1, kind: "benchmark", ompVersion: OMP_VERSION,
      inventoryObservedAt: now, startedAt: now, completedAt: now + 1,
      results: draft.benchmark.candidates.map(candidate => ({ ...candidate, status: "reachable", tokensPerSecond: 42, timeToFirstTokenMs: 80 })) };
    const derived = await accepted(f, "deriveCatalog", { inventory, benchmark, budget: "any" });
    expect(derived.document.models.map(model => model.tokensPerSecond)).toEqual([42, 42, 42]);
    benchmark.results[0]!.api = "different-api";
    expect(await invoke(f, "deriveCatalog", { inventory, benchmark, budget: "any" })).toEqual({ refused: "code_probe_missing_probe" });
    expect(await configuration(f)).toBeNull();
    // A refusal that names its subject keeps the name across the door.
    const regressing: InventoryReceipt = { ...inventory, models: [
      { ...inventory.models[0]!, id: "deep-entry", thinkingLevels: ["high"] },
      { ...inventory.models[2]!, id: "shallow-top", thinkingLevels: ["low"] },
    ] };
    const probed = (await accepted(f, "draftInventory", { inventory: regressing, budget: "any" })).benchmark.candidates;
    expect(await invoke(f, "deriveCatalog", { inventory: regressing, budget: "any", benchmark: { ...benchmark,
      results: probed.map(candidate => ({ ...candidate, status: "reachable", tokensPerSecond: 42, timeToFirstTokenMs: 80 })) } }))
      .toEqual({ refused: "code_ladder_regression: anthropic: anthropic/shallow-top regresses on anthropic/deep-entry" });
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

describe("verified catalogs and launch-time honesty", () => {
  async function verification(f: Fixture, revision: number, observation = accounts()) {
    const probe = await accepted(f, "composeProbe", { ...workspace, expectedRevision: revision, accounts: observation });
    return { ompVersion: "18.4.12", inventoryArtifactSha256: "c".repeat(64), catalogRevision: "a".repeat(64), inventoryObservedAt: now - 2000,
      benchmarkCompletedAt: now - 1000, accounts: observation, poolIdentityDigest: probe.poolIdentityDigest, budget: "any" as const };
  }

  test("a verification records the pool Code reads itself, and review and promotion carry exactly that provenance", async () => {
    const f = fixture(), record = await initialize(f);
    const verified = await verification(f, record.revision);
    const staged = await accepted(f, "stageCatalog", { ...workspace, expectedRevision: record.revision, document: document(), verification: verified });
    expect(staged.draft?.provenance).toEqual({ ompVersion: "18.4.12", inventoryArtifactSha256: "c".repeat(64), catalogRevision: "a".repeat(64),
      inventoryObservedAt: now - 2000, benchmarkCompletedAt: now - 1000, providers: ["anthropic"], poolIdentityDigest: verified.poolIdentityDigest });
    const review = await accepted(f, "reviewCatalog", { ...workspace, expectedRevision: staged.revision, source: "draft" });
    expect(review.provenance).toEqual(staged.draft!.provenance);
    expect(review.review.selection).toMatchObject({ lane: { kind: "provider", family: "anthropic", blend: "only" }, capability: 2, thinking: "medium" });
    const promoted = await accepted(f, "promoteCatalog", { ...workspace, expectedRevision: staged.revision, source: "draft", reviewDigest: review.reviewDigest });
    expect(promoted.active).toEqual(staged.draft);
    // Manual authorship stays exactly that: the same document staged without a verification is unverified.
    expect((await accepted(f, "stageCatalog", { ...workspace, expectedRevision: promoted.revision, document: document() })).draft?.provenance).toBeNull();
  });

  test("refusing a premium promotion preserves the staged verification and active workspace choices until actual-tier review", async () => {
    const f = fixture(), original = await active(f);
    const catalog: CatalogDocument = { schemaVersion: 1, models: [{ ...document().models[0]!,
      key: "fable", id: "claude-fable-5-2", tier: 4 }] };
    const verified = await verification(f, original.revision);
    const staged = await accepted(f, "stageCatalog", { ...workspace, expectedRevision: original.revision, document: catalog, verification: verified });
    const input = { ...workspace, expectedRevision: staged.revision, source: "draft" as const }, before = [...f.store];
    expect(await invoke(f, "reviewCatalog", { ...input, selection: original.selection! })).toEqual({ refused: "code_invalid_selection" });
    expect([...f.store]).toEqual(before);
    expect(await configuration(f)).toEqual(staged);
    expect(staged.active).toEqual(original.active);
    expect(staged.selection).toEqual(original.selection);
    expect(staged.accounts).toEqual(original.accounts);
    expect(staged.draft?.document).toEqual(catalog);
    expect(staged.draft?.digest).toBe(digestOf(catalog));
    expect(staged.draft?.provenance).toMatchObject({ inventoryArtifactSha256: verified.inventoryArtifactSha256,
      catalogRevision: verified.catalogRevision, poolIdentityDigest: verified.poolIdentityDigest,
      inventoryObservedAt: verified.inventoryObservedAt, benchmarkCompletedAt: verified.benchmarkCompletedAt });
    const selection = { ...original.selection!, capability: 4 as const };
    const review = await accepted(f, "reviewCatalog", { ...input, selection });
    const promoted = await accepted(f, "promoteCatalog", { ...input, selection, reviewDigest: review.reviewDigest });
    expect(promoted.active).toEqual(staged.draft);
    expect(promoted.selection).toEqual(selection);
    expect(promoted.accounts).toEqual(original.accounts);
  });

  test("an unverified preview names catalog models without manufacturing verified account coverage", async () => {
    const f = fixture(), record = await staged(f);
    const review = await accepted(f, "reviewCatalog", { ...workspace, expectedRevision: record.revision, source: "draft" });
    expect(review.review.selection).toMatchObject({ lane: { kind: "provider", family: "anthropic", blend: "only" }, capability: 2, thinking: "medium" });
    expect(review.provenance).toBeNull();
    expect(await configuration(f)).toEqual(record);
    const promoted = await accepted(f, "promoteCatalog", { ...workspace, expectedRevision: record.revision, source: "draft", reviewDigest: review.reviewDigest });
    expect(promoted.active?.provenance).toBeNull();
    expect(promoted.accounts).toEqual(record.accounts);
    expect(await invoke(f, "composeSession", { ...workspace, expectedRevision: promoted.revision,
      accounts: { ...accounts(), accounts: [] }, prompt: "" })).toEqual({ refused: "code_account_unavailable" });
  });

  test("a verification recorded without the OMP runtime and model catalog it ran against reads as unverified, without a schema change", async () => {
    const f = fixture(), record = await initialize(f);
    const staged = await accepted(f, "stageCatalog", { ...workspace, expectedRevision: record.revision, document: document(), verification: await verification(f, record.revision) });
    const review = await accepted(f, "reviewCatalog", { ...workspace, expectedRevision: staged.revision, source: "draft" });
    const promoted = await accepted(f, "promoteCatalog", { ...workspace, expectedRevision: staged.revision, source: "draft", reviewDigest: review.reviewDigest });
    // The record as schema 4 was first written: the same verification, without either identity.
    const { inventoryArtifactSha256: _artifact, catalogRevision: _catalog, ...unidentified } = promoted.active!.provenance!;
    const key = `configuration/${digestOf(workspace)}`, raw = JSON.stringify({ ...promoted, active: { ...promoted.active, provenance: unidentified } });
    f.store.set(key, raw);
    // Nothing compares it with the OMP present now, so it is no verification at all, and a read writes nothing.
    expect((await configuration(f))?.active?.provenance).toBeNull();
    expect(f.store.get(key)).toBe(raw);
    expect((await accepted(f, "reviewCatalog", { ...workspace, expectedRevision: promoted.revision, source: "active" })).provenance).toBeNull();
    // The next CAS persists the same schema version, unverified.
    const next = await accepted(f, "select", { ...workspace, expectedRevision: promoted.revision, selection: { ...promoted.selection!, planYolo: !promoted.selection!.planYolo } });
    expect(JSON.parse(f.store.get(key)!)).toMatchObject({ schemaVersion: 4, active: { provenance: null } });
    expect(next.active?.provenance).toBeNull();
  });

  test("a verification whose pool moved, or that claims what its pool and receipts cannot, stages nothing", async () => {
    const f = fixture(), record = await initialize(f);
    const verified = await verification(f, record.revision);
    const narrowed = { ...verified.accounts, accounts: verified.accounts.accounts.slice(1) };
    const input = { ...workspace, expectedRevision: record.revision, document: document() };
    expect(await invoke(f, "stageCatalog", { ...input, verification: { ...verified, accounts: narrowed } })).toEqual({ refused: "code_accounts_changed" });
    const elsewhere = document();
    elsewhere.models.push({ ...elsewhere.models[0]!, key: "elsewhere", provider: "deepseek", id: "native-elsewhere", api: "openai-completions" });
    expect(await invoke(f, "stageCatalog", { ...input, document: elsewhere, verification: verified })).toEqual({ refused: "code_invalid_provenance" });
    expect(await invoke(f, "stageCatalog", { ...input, verification: { ...verified, benchmarkCompletedAt: verified.inventoryObservedAt - 1 } }))
      .toEqual({ refused: "code_invalid_provenance" });
    expect(await invoke(f, "stageCatalog", { ...input, verification: { ...verified, accounts: { ...verified.accounts, observedAt: now + 1 } } }))
      .toEqual({ refused: "code_invalid_accounts" });
    expect(await configuration(f)).toEqual(record);
  });

  test("a launch prunes the fallbacks no included account serves and still refuses a lead nobody serves", async () => {
    // Mixed at capability 3: the tier-2 GPT rung, alone on `openai`, is only a fallback, while Codex leads ordinary work.
    const rung = (key: string, provider: string, tier: 1 | 2 | 3, inputCostPerMillion: number) => ({ ...document().models[0]!,
      key, provider, id: `native-${key}`, api: "openai-codex-responses", tier, inputCostPerMillion, images: true });
    const catalog: CatalogDocument = { schemaVersion: 1, models: [rung("o1", "openai-codex", 1, 1), rung("o2", "openai", 2, 2),
      rung("o3", "openai-codex", 3, 3), rung("a1", "anthropic", 1, 1), rung("a2", "anthropic", 2, 2), rung("a3", "anthropic", 3, 3)] };
    const f = fixture();
    f.published = published(catalog.models);
    const record = await staged(f, catalog);
    const review = await accepted(f, "reviewCatalog", { ...workspace, expectedRevision: record.revision, source: "draft" });
    const promoted = await accepted(f, "promoteCatalog", { ...workspace, expectedRevision: record.revision, source: "draft", reviewDigest: review.reviewDigest });
    const saved = await accepted(f, "select", { ...workspace, expectedRevision: promoted.revision,
      selection: { ...promoted.selection!, lane: { kind: "mixed" }, capability: 3, fallback: true, advisor: "off" } });
    const scope = accounts().scope;
    const slot = (provider: string, credentialId: number) => ({ reference: { kind: "credential" as const, scope, provider, credentialId },
      credentialId, identityKey: null, type: "api_key" as const, email: null, disabled: false, blocks: [] });
    const input = { ...workspace, expectedRevision: saved.revision, prompt: "" };
    const composed = await accepted(f, "composeSession", { ...input, accounts: { ...accounts(), accounts: [slot("openai-codex", 1), slot("anthropic", 3)] } });
    expect(composed.review.routes.flatMap(entry => entry.fallback).some(choice => choice.key === "o2")).toBe(false);
    expect(composed.review.routes.some(entry => entry.fallback.length > 0)).toBe(true);
    expect(Object.values(composed.overlay.retry?.fallbackChains ?? {}).flat().some(reference => reference.startsWith("openai/"))).toBe(false);
    // With both providers served, the same fallbacks are routed rather than pruned.
    const both = await accepted(f, "composeSession", { ...input, accounts: { ...accounts(), accounts: [slot("openai-codex", 1), slot("openai", 2), slot("anthropic", 3)] } });
    expect(both.review.routes.flatMap(entry => entry.fallback).some(choice => choice.key === "o2")).toBe(true);
    expect(await invoke(f, "composeSession", { ...input, accounts: { ...accounts(), accounts: [slot("openai", 2), slot("anthropic", 3)] } }))
      .toEqual({ refused: "code_account_unavailable" });
  });

  test("a launch refuses, naming them, routed models the current OMP no longer publishes", async () => {
    const f = fixture(), record = await active(f);
    const input = { ...workspace, expectedRevision: record.revision, accounts: accounts(), prompt: "" };
    const composed = await accepted(f, "composeSession", input);
    f.published = published(document().models.filter(model => model.tier !== 2));
    expect(await invoke(f, "composeSession", input)).toEqual({ refused: "code_model_unpublished: anthropic/native-model2" });
    f.published = published([]);
    expect(await invoke(f, "composeSession", input))
      .toEqual({ refused: "code_model_unpublished: anthropic/native-model1, anthropic/native-model2" });
    // Another OMP list that still publishes every routed model composes, as a different composition.
    f.published = { ...published(), revision: "b".repeat(64) };
    expect((await accepted(f, "composeSession", input)).compositionDigest).not.toBe(composed.compositionDigest);
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
