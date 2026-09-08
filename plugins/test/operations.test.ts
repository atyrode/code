import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { assertStorageKey, assertStorageValue } from "@manifold/plugin";
import { canonicalJobJson, PublicJobSchema, type PublicJob } from "@manifold/protocol";
import { CODE_PLUGIN_ID, type PrepareLaunchInput } from "../atyrode.code/contract.ts";
import { type CodeConfiguration, type CodeOperation } from "../atyrode.code/machine-contract.ts";
import { catalogPayload, machineHandlers, type CodeContext } from "../atyrode.code/machine-server.ts";
import { handlers } from "../atyrode.code/server.ts";

const alice = { provider: "openai-codex", identityKey: "alice@example.test" };
const bob = { provider: "openai-codex", identityKey: "bob@example.test" };
const choiceState = { schemaVersion: 1 as const, activePreset: "Manual", presets: [], manualDisabled: [] };
const accounts = {
  ...choiceState, operation: "list", observedAt: 1_700_000_000,
  accounts: [alice, bob].map((account) => ({ ...account, selectable: true, enabled: true, blocked: false, restrictions: [] })), baseRevision: 1,
};
const selection = { lane: "A", model: "test", thinking: "high", advisor: "off", spark: "off", fast: "off", prewalk: "off", planyolo: "off", fallback: "off" };
const modelsYaml = "version: 1\n";
const catalogRevision = createHash("sha256").update(modelsYaml).digest("hex");
const inspection = {
  schemaVersion: 1, baseRevision: 1, catalogRevision, observedAt: 1_700_000_000, selection,
  facets: [{ key: "lane", values: ["A", "B"] }], routing: [{ role: "default", lead: "openai-codex/test", fallback: [], agentBacked: false }],
  estimates: { costScore: 2, speedScore: 3, scaleMin: 1, scaleMax: 5 }, ready: true, refusals: [],
};
const key = `account-preferences/${createHash("sha256").update("m1").digest("hex")}`;
function fixture() {
  const store = new Map<string, string>();
  const jobs = new Map<string, { job: PublicJob; bytes: Buffer }>();
  const denied = new Set<string>();
  const deniedOutputs = new Set<string>();
  const emissions: unknown[] = [];
  const fault = { corruptOutput: false, wrongOutputJob: false, writable: true, starts: 0, binding: "d".repeat(64) };
  let nextId = 0;
  const ctx: CodeContext = {
    storage: {
      pluginId: CODE_PLUGIN_ID,
      get: async (key) => store.get(key) ?? null,
      set: async (key, value) => { assertStorageKey(key); assertStorageValue(key, value); store.set(key, value); },
      delete: async (key) => { assertStorageKey(key); store.delete(key); },
      keys: async (prefix) => [...store.keys()].filter((key) => prefix === undefined || key.startsWith(prefix)),
      compareAndSet: async (key, expected, value) => {
        assertStorageKey(key); assertStorageValue(key, value);
        if (expected !== null) assertStorageValue(key, expected);
        if ((store.get(key) ?? null) !== expected) return false;
        store.set(key, value);
        return true;
      },
    },
    auth: {
      principal: { id: "p1", kind: "human", name: "Tester", color: "#123456" },
      caps: ["machines:run", "jobs:read"], containerScope: null, isRoot: false,
      allows: async () => fault.writable,
    },
    newId: async () => `job-${++nextId}`,
    emit: (...event) => { emissions.push(event); },
    jobs: {
      describe: async () => ({ machineId: "m1", pluginId: CODE_PLUGIN_ID, admissionPublicKey: "-----BEGIN PUBLIC KEY-----test", connected: true, platforms: ["linux-amd64"],
        installation: { revision: "installation-1", artifactSha256: "a".repeat(64), enabled: true, ready: true, purgeRequested: false }, retainedInstallations: [], consents: [],
        operations: Object.fromEntries(["inspect", "analysis-plan", "catalog-review", "launch", "suggest"].map((operation) => [`${CODE_PLUGIN_ID}.${operation}`, { ready: true, reason: null, resourceBindingDigest: fault.binding }])) }),
      execute: async () => { fault.starts++; throw new Error("Unexpected execution"); },
      status: async (node) => {
        if (denied.has(node.jobId)) throw new Error("Current native authority denied");
        const entry = jobs.get(node.jobId);
        if (!entry) throw new Error("No such job");
        return entry.job;
      },
      listRuns: async ({ machineId, operationId, limit = 50 }) => ({
        runs: [...jobs.values()].reverse().filter(({ job }) => !denied.has(job.jobId) && job.machineId === machineId &&
          (operationId === undefined || job.operationId === operationId)).slice(0, limit).map(({ job }) => ({ job, occurrence: null })),
        nextCursor: null,
      }),
      output: async ({ node, offset, maxBytes }) => {
        if (denied.has(node.jobId) || deniedOutputs.has(node.jobId)) throw new Error("Current output authority denied");
        const entry = jobs.get(node.jobId);
        if (!entry) throw new Error("No such output");
        const bytes = Buffer.from(entry.bytes.subarray(offset, offset + maxBytes));
        if (fault.corruptOutput && bytes.length > 0) bytes[0] = bytes[0]! ^ 1;
        return { type: "output", jobId: fault.wrongOutputJob ? "other-job" : node.jobId, outputId: node.outputId,
          requestId: "read-output", seq: offset, data: bytes.toString("base64"), eof: offset + bytes.length === entry.bytes.length };
      },
      input: async () => { throw new Error("Unexpected input"); },
      cancel: async () => { throw new Error("Unexpected cancellation"); },
      follow: async () => { throw new Error("Unexpected following"); },
    },
  };
  function add(operation: CodeOperation, value: unknown, machineId = "m1", payload: unknown = {}) {
    const jobId = `job-${++nextId}`;
    const bytes = Buffer.from(JSON.stringify(value));
    const artifactSha256 = "a".repeat(64);
    const job = PublicJobSchema.parse({
      jobId, machineId, operationId: `${CODE_PLUGIN_ID}.${operation}`, pluginId: CODE_PLUGIN_ID,
      installationRevision: "installation-1", artifactSha256, state: "exited", resourceBindingDigest: "d".repeat(64), inputDigest: createHash("sha256").update(canonicalJobJson({ payload: JSON.stringify(payload) })).digest("hex"),
      authority: { origin: { kind: "action", traceId: `trace-${jobId}`, door: "atyrode.code.run" }, requester: "p1",
        executor: { machineId, ownerId: "owner", ownerGeneration: 1 }, decision: null },
      result: { jobId, requestDigest: "b".repeat(64), ownerId: "owner", ownerGeneration: 1, state: "exited",
        exitCode: 0, reason: null, startedAt: 1000, finishedAt: 1100, usage: null,
        limits: { timeoutMs: 30000, memoryBytes: 536870912, processes: 32, outputBytes: 2097152 },
        outputs: [{ outputId: `output-${jobId}`, name: "stdout", sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length, files: 1 }] },
    });
    jobs.set(jobId, { job, bytes });
    return job;
  }
  return { ctx, store, jobs, denied, deniedOutputs, emissions, fault, add };
}

function activeConfiguration(f: ReturnType<typeof fixture>): CodeConfiguration {
  const configuration: CodeConfiguration = {
    schemaVersion: 2, machineId: "m1", revision: 1, state: choiceState, choiceSource: null, selection,
    active: { catalogRevision, modelsYaml, generation: null, review: null }, draft: null, updatedBy: "p1",
    resourcePins: { installationRevision: "installation-1", artifactSha256: "a".repeat(64),
      operations: Object.fromEntries(["inspect", "analysis-plan", "launch", "suggest"].map((op) => [`${CODE_PLUGIN_ID}.${op}`, "d".repeat(64)])) },
  };
  f.store.set(key, JSON.stringify(configuration));
  return configuration;
}
function launchInput(planJobId: string, expectedRevision = 1): PrepareLaunchInput {
  return { machineId: "m1", planJobId, expectedRevision, prompt: "Review this change" };
}
const planValue = { ...inspection, configYaml: "model: openai-codex/test\n", flags: ["--no-tools"], accountPool: { "openai-codex": [alice.identityKey] } };

describe("native Code configuration", () => {
  test("initialization preserves existing same-store choices and refuses resetting them", async () => {
    const f = fixture();
    const source = f.add("account-set", { ...accounts, manualDisabled: [alice] });
    const previous = { schemaVersion: 1, machineId: "m1", revision: 4, state: { ...choiceState, manualDisabled: [alice] }, source: { operation: "account-set", jobId: source.jobId } };
    f.store.set(key, JSON.stringify(previous));
    expect(await machineHandlers.readConfiguration(f.ctx, { machineId: "m1" })).toMatchObject({ status: "transition_required", previousChoices: previous.state });
    expect(JSON.parse(f.store.get(key)!)).toEqual(previous);
    expect(await machineHandlers.initializeConfiguration(f.ctx, { machineId: "m1", expectedRevision: 4 })).toMatchObject({ schemaVersion: 2, revision: 5, state: previous.state, choiceSource: previous.source });
    expect(await machineHandlers.initializeConfiguration(f.ctx, { machineId: "m1", expectedRevision: 5 })).toEqual({ refused: "code_stale_preferences" });
    expect(f.store.size).toBe(1);
  });

  test("competing proposals cannot overwrite each other or a reviewed launch", async () => {
    const f = fixture(); const configuration = activeConfiguration(f);
    const plan = f.add("analysis-plan", planValue, "m1", catalogPayload(configuration));
    const first = f.add("account-set", { ...accounts, manualDisabled: [alice] });
    const second = f.add("account-set", { ...accounts, manualDisabled: [bob] });
    const results = await Promise.all([first, second].map((job) => machineHandlers.applyAccountChoices(f.ctx, { machineId: "m1", operation: "account-set", jobId: job.jobId })));
    const successes = results.filter((result) => !("refused" in result));
    expect(successes).toHaveLength(1);
    expect(results).toContainEqual({ refused: "code_stale_preferences" });
    const winner = successes[0]!;
    expect(await machineHandlers.applyAccountChoices(f.ctx, { machineId: "m1", operation: "account-set", jobId: winner.jobId })).toEqual(winner);
    expect(await handlers.prepareLaunch(f.ctx, launchInput(plan.jobId))).toEqual({ refused: "code_stale_preferences" });
    expect(JSON.stringify(f.emissions)).not.toContain("@example.test");
  });

  test("revoking source output access prevents cached identities from being disclosed", async () => {
    const f = fixture(); activeConfiguration(f);
    const source = f.add("account-set", { ...accounts, manualDisabled: [alice] });
    await machineHandlers.applyAccountChoices(f.ctx, { machineId: "m1", operation: "account-set", jobId: source.jobId });
    f.deniedOutputs.add(source.jobId);
    expect(await machineHandlers.readConfiguration(f.ctx, { machineId: "m1" })).toEqual({ refused: "code_observation_unavailable" });
    expect(await machineHandlers.observe(f.ctx, { machineId: "m1", operation: "accounts-list" })).toEqual({ refused: "code_observation_unavailable" });
    f.deniedOutputs.clear(); f.denied.add(source.jobId);
    expect(await machineHandlers.readConfiguration(f.ctx, { machineId: "m1" })).toEqual({ refused: "code_observation_unavailable" });
  });

  test.each(["corruptOutput", "wrongOutputJob"] as const)("refuses %s rather than committing unverified choices", async (fault) => {
    const f = fixture(); activeConfiguration(f);
    const before = f.store.get(key);
    const proposal = f.add("account-set", { ...accounts, manualDisabled: [alice] });
    f.fault[fault] = true;
    expect(await machineHandlers.applyAccountChoices(f.ctx, { machineId: "m1", operation: "account-set", jobId: proposal.jobId })).toEqual({ refused: "code_operation_unavailable" });
    expect(f.store.get(key)).toEqual(before);
  });

  test("native direct execution cannot spoof governed configuration provenance", async () => {
    const f = fixture(); activeConfiguration(f);
    const proposal = f.add("account-set", { ...accounts, manualDisabled: [alice] });
    if (proposal.authority.origin.kind !== "action") throw new Error("fixture");
    proposal.authority.origin.door = "engine.jobs.execute";
    expect(await machineHandlers.applyAccountChoices(f.ctx, { machineId: "m1", operation: "account-set", jobId: proposal.jobId })).toEqual({ refused: "code_operation_unavailable" });
  });

  test("promotion binds exact reviewed source and current choice payload, with CAS", async () => {
    const f = fixture(); activeConfiguration(f);
    const staged = await machineHandlers.stageConfiguration(f.ctx, { machineId: "m1", expectedRevision: 1, source: { kind: "edit", modelsYaml } });
    if ("refused" in staged) throw new Error(staged.refused);
    const forged = f.add("catalog-review", { ...inspection, baseRevision: 2 }, "m1", { ...catalogPayload(staged, true), state: { ...choiceState, manualDisabled: [alice] } });
    expect(await machineHandlers.promoteConfiguration(f.ctx, { machineId: "m1", expectedRevision: 2, reviewJobId: forged.jobId })).toEqual({ refused: "code_preview_changed" });
    const reviewed = f.add("catalog-review", { ...inspection, baseRevision: 2, ready: false, refusals: ["broker_metadata_unavailable"] }, "m1", catalogPayload(staged, true));
    expect(await machineHandlers.promoteConfiguration(f.ctx, { machineId: "m1", expectedRevision: 2, reviewJobId: reviewed.jobId })).toMatchObject({ revision: 3, active: { modelsYaml, catalogRevision }, draft: null, selection });
    expect(await machineHandlers.promoteConfiguration(f.ctx, { machineId: "m1", expectedRevision: 2, reviewJobId: reviewed.jobId })).toEqual({ refused: "code_stale_preferences" });
  });

  test("launch derives runtime input only from the exact authorized plan and refuses resource drift", async () => {
    const f = fixture(); const configuration = activeConfiguration(f);
    const plan = f.add("analysis-plan", planValue, "m1", catalogPayload(configuration));
    expect(await handlers.prepareLaunch(f.ctx, launchInput(plan.jobId))).toMatchObject({ runtime: {
      pluginId: CODE_PLUGIN_ID, operationId: "atyrode.code.launch", installationRevision: "installation-1", artifactSha256: "a".repeat(64), resourceBindingDigest: "d".repeat(64),
      input: { configYaml: planValue.configYaml, flags: JSON.stringify(planValue.flags), accountPool: JSON.stringify(planValue.accountPool), prompt: "Review this change" },
    } });
    f.fault.binding = "e".repeat(64);
    expect(await handlers.prepareLaunch(f.ctx, launchInput(plan.jobId))).toEqual({ refused: "code_resources_changed" });
    f.fault.binding = "d".repeat(64);
    const other = f.add("analysis-plan", planValue, "m2", catalogPayload(configuration));
    expect(await handlers.prepareLaunch(f.ctx, launchInput(other.jobId))).toEqual({ refused: "code_observation_unavailable" });
  });

  test("an explicit observation stays attached to its job when another participant submits", async () => {
    const f = fixture(); const configuration = activeConfiguration(f);
    const requested = f.add("inspect", inspection, "m1", catalogPayload(configuration));
    const later = f.add("inspect", { ...inspection, selection: { ...selection, lane: "B" } });
    expect(await machineHandlers.observe(f.ctx, { machineId: "m1", operation: "inspect" })).toMatchObject({ snapshot: { job: { jobId: later.jobId } }, failure: "stale_preferences" });
    expect(await machineHandlers.observe(f.ctx, { machineId: "m1", operation: "inspect", jobId: requested.jobId })).toMatchObject({ state: "ready", snapshot: { job: { jobId: requested.jobId } } });
  });
});
