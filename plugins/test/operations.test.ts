import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { assertStorageKey, assertStorageValue } from "@manifold/plugin";
import { PublicJobSchema, type PublicJob } from "@manifold/protocol";
import { CODE_PLUGIN_ID, type PrepareLaunchInput } from "../atyrode.code/contract.ts";
import { type CodeOperation } from "../atyrode.code/machine-contract.ts";
import { machineHandlers, type CodeContext } from "../atyrode.code/machine-server.ts";
import { handlers } from "../atyrode.code/server.ts";

const alice = { provider: "openai-codex", identityKey: "alice@example.test" };
const bob = { provider: "openai-codex", identityKey: "bob@example.test" };
const accounts = {
  schemaVersion: 1, operation: "list", observedAt: 1_700_000_000, activePreset: "Manual",
  accounts: [alice, bob].map((account) => ({ ...account, selectable: true, enabled: true, blocked: false, restrictions: [] })),
  presets: [], manualDisabled: [], baseRevision: 0,
};
const inspection = {
  schema_version: 1, baseRevision: null, observed_at: "2026-09-08T12:00:00Z", observation: "one_shot",
  catalog: { state: "ready" }, selection: { lane: "A" }, facets: [{ key: "lane", values: ["A", "B"] }],
  routing: [{ role: "default", primary: "openai-codex/test", fallbacks: [], agent_override: false }],
  estimates: null, providers: [{ id: "openai-codex", credential_state: "available" }],
  launch_modes: [{ mode: "generated", available: true }, { mode: "managed", available: true }], runtime_targets: [],
};

function fixture() {
  const store = new Map<string, string>();
  const jobs = new Map<string, { job: PublicJob; bytes: Buffer }>();
  const denied = new Set<string>();
  const emissions: unknown[] = [];
  const fault = { corruptOutput: false, wrongOutputJob: false, writable: true, starts: 0 };
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
        if (denied.has(node.jobId)) throw new Error("Current output authority denied");
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
  function add(operation: CodeOperation, value: unknown, machineId = "m1") {
    const jobId = `job-${++nextId}`;
    const bytes = Buffer.from(JSON.stringify(value));
    const artifactSha256 = "a".repeat(64);
    const job = PublicJobSchema.parse({
      jobId, machineId, operationId: `${CODE_PLUGIN_ID}.${operation}`, pluginId: CODE_PLUGIN_ID,
      installationRevision: "installation-1", artifactSha256, state: "exited",
      authority: { origin: { kind: "action", traceId: `trace-${jobId}` }, requester: "p1",
        executor: { machineId, ownerId: "owner", ownerGeneration: 1 }, decision: null },
      result: { jobId, requestDigest: "b".repeat(64), ownerId: "owner", ownerGeneration: 1, state: "exited",
        exitCode: 0, reason: null, startedAt: 1000, finishedAt: 1100, usage: null,
        limits: { timeoutMs: 30000, memoryBytes: 536870912, processes: 32, outputBytes: 2097152 },
        outputs: [{ outputId: `output-${jobId}`, name: "stdout", sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length, files: 1 }] },
    });
    jobs.set(jobId, { job, bytes });
    return job;
  }
  return { ctx, store, jobs, denied, emissions, fault, add };
}

function launchInput(inspectionJobId: string, baselineJobId: string, revision: number): PrepareLaunchInput {
  return { machineId: "m1", inspectionJobId, kind: "generated", selection: { lane: "A" }, worktree: false, prompt: "",
    accounts: { source: "plugin", revision, baselineJobId } };
}

describe("shared Code choices", () => {
  test("competing proposals cannot overwrite each other or change the reviewed launch pool", async () => {
    const f = fixture();
    const baseline = f.add("accounts-list", accounts);
    const first = f.add("account-set", { ...accounts, operation: "set", manualDisabled: [alice] });
    const second = f.add("account-set", { ...accounts, operation: "set", manualDisabled: [bob] });
    const results = await Promise.all([first, second].map((job) => machineHandlers.applyAccountChoices(f.ctx, {
      machineId: "m1", operation: "account-set", jobId: job.jobId,
    })));
    const successes = results.filter((result) => !("refused" in result));
    expect(successes).toHaveLength(1);
    expect(results).toContainEqual({ refused: "code_stale_preferences" });
    const winner = successes[0]!;
    if ("refused" in winner) throw new Error(winner.refused);
    expect(await machineHandlers.applyAccountChoices(f.ctx, { machineId: "m1", operation: "account-set", jobId: winner.jobId })).toEqual(winner);
    const reviewed = f.add("inspect", { ...inspection, baseRevision: 1 });
    const launch = await handlers.prepareLaunch(f.ctx, launchInput(reviewed.jobId, baseline.jobId, 1));
    if ("refused" in launch) throw new Error(launch.refused);
    const choice = launch.program.argv.find((arg) => arg.startsWith("--account-selection="));
    expect(choice).toBeDefined();
    expect(JSON.parse(choice!.slice("--account-selection=".length))).toEqual({
      schemaVersion: 1, disabled: [winner.jobId === first.jobId ? alice : bob],
    });
    expect(f.emissions).toHaveLength(1);
    expect(JSON.stringify(f.emissions)).not.toContain("@example.test");
    expect(await machineHandlers.run(f.ctx, {
      machineId: "m1", operation: "account-set", input: { provider: alice.provider, identity: alice.identityKey, enabled: true,
        expectedRevision: 0, baselineJobId: baseline.jobId },
    })).toEqual({ refused: "code_stale_preferences" });
    expect(f.fault.starts).toBe(0);
  });

  test("source-job revocation prevents cached choices from being observed or launched", async () => {
    const f = fixture();
    const baseline = f.add("accounts-list", accounts);
    const proposal = f.add("account-set", { ...accounts, operation: "set", manualDisabled: [alice] });
    expect(await machineHandlers.applyAccountChoices(f.ctx, { machineId: "m1", operation: "account-set", jobId: proposal.jobId })).toEqual({ revision: 1, jobId: proposal.jobId });
    const reviewed = f.add("inspect", { ...inspection, baseRevision: 1 });
    f.denied.add(proposal.jobId);
    expect(await machineHandlers.observe(f.ctx, { machineId: "m1", operation: "accounts-list" })).toEqual({ refused: "code_observation_unavailable" });
    expect(await handlers.prepareLaunch(f.ctx, launchInput(reviewed.jobId, baseline.jobId, 1))).toEqual({ refused: "code_observation_unavailable" });
    f.denied.clear();
    f.fault.writable = false;
    const other = f.add("account-set", { ...accounts, operation: "set", baseRevision: 1, manualDisabled: [bob] });
    const before = [...f.store.values()];
    expect(await machineHandlers.applyAccountChoices(f.ctx, { machineId: "m1", operation: "account-set", jobId: other.jobId })).toEqual({ refused: "code_operation_unavailable" });
    expect([...f.store.values()]).toEqual(before);
  });

  test.each(["corruptOutput", "wrongOutputJob"] as const)("refuses %s instead of committing an unverified proposal", async (fault) => {
    const f = fixture();
    const proposal = f.add("account-set", { ...accounts, operation: "set", manualDisabled: [alice] });
    f.fault[fault] = true;
    expect(await machineHandlers.applyAccountChoices(f.ctx, { machineId: "m1", operation: "account-set", jobId: proposal.jobId })).toEqual({ refused: "code_operation_unavailable" });
    expect(await machineHandlers.observe(f.ctx, { machineId: "m1", operation: "account-set", jobId: proposal.jobId })).toMatchObject({ state: "failed", failure: "invalid_result", snapshot: null });
    expect(f.store.size).toBe(0);
    expect(f.emissions).toEqual([]);
  });

  test("a launch cannot use a preview from another account revision or machine", async () => {
    const f = fixture();
    const baseline = f.add("accounts-list", accounts);
    const proposal = f.add("account-set", { ...accounts, operation: "set", manualDisabled: [alice] });
    await machineHandlers.applyAccountChoices(f.ctx, { machineId: "m1", operation: "account-set", jobId: proposal.jobId });
    const stale = f.add("inspect", { ...inspection, baseRevision: 0 });
    expect(await handlers.prepareLaunch(f.ctx, launchInput(stale.jobId, baseline.jobId, 1))).toEqual({ refused: "code_stale_preferences" });
    const wrongMachine = f.add("inspect", { ...inspection, baseRevision: 1 }, "m2");
    expect(await handlers.prepareLaunch(f.ctx, launchInput(wrongMachine.jobId, baseline.jobId, 1))).toEqual({ refused: "code_observation_unavailable" });
  });

  test("an explicit observation remains bound to its job when another participant submits later", async () => {
    const f = fixture();
    const requested = f.add("inspect", inspection);
    const later = f.add("inspect", { ...inspection, selection: { lane: "B" } });
    expect(await machineHandlers.observe(f.ctx, { machineId: "m1", operation: "inspect" })).toMatchObject({ snapshot: { job: { jobId: later.jobId }, value: { selection: { lane: "B" } } } });
    expect(await machineHandlers.observe(f.ctx, { machineId: "m1", operation: "inspect", jobId: requested.jobId })).toMatchObject({ snapshot: { job: { jobId: requested.jobId }, value: { selection: { lane: "A" } } } });
  });
});
